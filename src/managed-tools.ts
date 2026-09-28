import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";

/** The formatter packages OpenCode installs and updates itself. */
export const SUPPORTED_MANAGED_TOOLS: readonly string[] = ["prettier", "oxfmt", "@biomejs/biome"];

/**
 * The cache directory whose entire contents (every generation) are invalidated
 * to reinstall one managed tool. Scoped to `<name>@latest`, never a plugin or
 * another tool.
 */
export function managedToolCacheDir(cacheDir: string, name: string): string {
  return join(cacheDir, "npm", `${name}@latest`);
}

export interface ManagedTool {
  name: string;
  /** Undefined when the newest generation's manifest is missing or unreadable. */
  version?: string;
}

export interface ManagedToolsPort {
  /** Formatter packages installed in this machine's V2 generation cache. */
  installed(): readonly ManagedTool[];
}

/**
 * The host only ever installs formatters through `Npm.which("<bare name>")`,
 * so their cache key is always `<name>@latest`; any other spec directory is
 * not a host-managed formatter.
 */
function newestGeneration(cacheDir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(managedToolCacheDir(cacheDir, name));
  } catch {
    return undefined;
  }
  const generations = entries.filter((entry) => /^\d+$/.test(entry)).toSorted((a, b) => Number(a) - Number(b));
  const generation = generations.at(-1);
  return generation === undefined ? undefined : join(managedToolCacheDir(cacheDir, name), generation);
}

function manifestVersion(generation: string, name: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(generation, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    );
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

// Relative XDG_CACHE_HOME values are invalid by specification.
function cacheDirectory(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "opencode");
}

/** The V2 npm cache root where managed tools are installed. */
export function managedCacheDirectory(): string {
  return cacheDirectory();
}

export function createManagedToolsPort(roots: { cacheDir?: string } = {}): ManagedToolsPort {
  const cacheDir = roots.cacheDir ?? cacheDirectory();
  return {
    installed() {
      const tools: ManagedTool[] = [];
      for (const name of SUPPORTED_MANAGED_TOOLS) {
        const generation = newestGeneration(cacheDir, name);
        // No generation means the host never installed the formatter; an
        // installed one with an unreadable manifest stays visible as unknown.
        if (generation === undefined) continue;
        const version = manifestVersion(generation, name);
        tools.push(version === undefined ? { name } : { name, version });
      }
      return tools;
    },
  };
}

export type LocalityVerdict = { local: true } | { local: false; reason: string };

export interface LocalityPort {
  /** Whether the connected server provably runs on this machine. */
  verify(signal?: AbortSignal): Promise<LocalityVerdict>;
}

export interface ServerLocalityOptions {
  /** The local opencode tmp root to compare with the server's report. */
  tmpRoot?: () => string;
  /** Whether a process id names a live process on this machine. */
  processAlive?: (pid: number) => boolean;
}

/**
 * The local cache describes this machine only, so it may back the managed
 * tools section solely when the server is provably local. The public surface
 * offers two signals — the server's tmp root and its process id — and anything
 * unverifiable counts as remote.
 */
export function createServerLocalityPort(
  client: Plugin.Context["client"],
  options: ServerLocalityOptions = {},
): LocalityPort {
  const tmpRoot = options.tmpRoot ?? localTmpRoot;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  return {
    async verify(signal) {
      let info: Awaited<ReturnType<Plugin.Context["client"]["server"]["info"]>>;
      try {
        info = await client.server.info({ signal });
      } catch {
        return { local: false, reason: "the server did not report its identity" };
      }
      const reported = info?.paths?.tmp;
      const pid = info?.pid;
      let local: string | undefined;
      try {
        local = tmpRoot();
      } catch {
        local = undefined;
      }
      if (
        typeof reported !== "string" ||
        local === undefined ||
        reported !== local ||
        typeof pid !== "number" ||
        !Number.isInteger(pid) ||
        pid <= 0 ||
        !processAlive(pid)
      ) {
        return { local: false, reason: "the connected server is not on this machine" };
      }
      return { local: true };
    },
  };
}

function localTmpRoot(): string {
  // The server reports its canonicalized tmp root (`os.tmpdir()/opencode`).
  return realpathSync(join(tmpdir(), "opencode"));
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves a live process owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
