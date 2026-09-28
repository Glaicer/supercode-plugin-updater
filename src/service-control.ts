import { spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin/tui";

export interface ReinstallRequest {
  /** The connected server process to stop and bring back. */
  pid: number;
  /** The npm cache root whose `<name>@latest` dirs are invalidated. */
  cacheDir: string;
  /** The managed tool names to reinstall (validated before spawn). */
  names: readonly string[];
}

export type DetachedSpawn = (command: string, args: readonly string[]) => void;

export interface ServiceControlPort {
  /**
   * Launch the detached supervisor that performs stop -> invalidate -> start.
   * Returns once it is spawned: the sequence completes independently of this
   * plugin, so a dropped TUI connection cannot leave the server stopped.
   */
  reinstall(request: ReinstallRequest): void;
}

function supervisorPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "reinstall-supervisor.js");
}

export function createServiceControlPort(
  options: { opencode?: string; supervisor?: string; spawnDetached?: DetachedSpawn } = {},
): ServiceControlPort {
  const opencode = options.opencode ?? "opencode";
  const supervisor = options.supervisor ?? supervisorPath();
  const spawnDetached: DetachedSpawn =
    options.spawnDetached ??
    ((command, args) => {
      const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
      // Detach fully: the supervisor outlives the TUI and never blocks it.
      child.unref();
    });
  return {
    reinstall(request) {
      // The host runtime is the compiled `opencode` binary, which cannot run a
      // bare script, so the supervisor runs under `node` from PATH (the plugin
      // already requires node) — the same "spawn from PATH" contract as the CLI.
      spawnDetached("node", [
        supervisor,
        "--pid",
        String(request.pid),
        "--cache",
        request.cacheDir,
        "--tools",
        request.names.join(","),
        "--opencode",
        opencode,
      ]);
    },
  };
}

export type ManagedServerVerdict = { ok: true } | { ok: false; reason: string };

export interface ManagedServerPort {
  /**
   * Whether the connected server is the local managed daemon this machine's
   * `opencode service stop`/`start` control. True only when it is verifiably on
   * this machine AND its process id is the one registered in the service file —
   * a remote, standalone, or otherwise unconfirmed server is never eligible.
   */
  verify(signal?: AbortSignal): Promise<ManagedServerVerdict>;
}

export interface ManagedServerOptions {
  /** The local opencode tmp root to compare with the server's report. */
  tmpRoot?: () => string;
  /** Directory holding the service registration files (`service*.json`). */
  serviceDir?: () => string;
  /** Whether a process id names a live process on this machine. */
  processAlive?: (pid: number) => boolean;
}

function localTmpRoot(): string {
  return join(realpathOr(tmpdir()), "opencode");
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Relative XDG_STATE_HOME values are invalid by specification.
function stateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
  return join(base, "opencode");
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pids named by any service registration file (`service.json`, `service-<channel>.json`). */
function registeredPids(serviceDir: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(serviceDir);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^service[^/]*\.json$/.test(entry)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(serviceDir, entry), "utf8"));
      const pid = (parsed as { pid?: unknown } | null)?.pid;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) pids.push(pid);
    } catch {
      // A corrupt registration is not evidence of any managed daemon.
    }
  }
  return pids;
}

/**
 * The reinstall action may only run against the managed local daemon. A local
 * cache is not enough on its own: the connected server's pid must be the one
 * registered in the service file, which is exactly the process
 * `opencode service stop` will terminate. Anything unverifiable is ineligible.
 */
export function createManagedServerPort(
  client: Plugin.Context["client"],
  options: ManagedServerOptions = {},
): ManagedServerPort {
  const tmpRoot = options.tmpRoot ?? localTmpRoot;
  const serviceDir = options.serviceDir ?? stateDirectory;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  return {
    async verify(signal) {
      let info: Awaited<ReturnType<Plugin.Context["client"]["server"]["info"]>>;
      try {
        info = await client.server.info({ signal });
      } catch {
        return { ok: false, reason: "the server did not report its identity" };
      }
      const pid = info?.pid;
      const reported = info?.paths?.tmp;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return { ok: false, reason: "the server reported no process id" };
      }
      let local: string | undefined;
      try {
        local = tmpRoot();
      } catch {
        local = undefined;
      }
      if (typeof reported !== "string" || local === undefined || reported !== local) {
        return { ok: false, reason: "the connected server is not on this machine" };
      }
      if (!processAlive(pid)) {
        return { ok: false, reason: "the connected server process is not live" };
      }
      let servicePath: string;
      try {
        servicePath = serviceDir();
      } catch {
        return { ok: false, reason: "the service registration is unreadable" };
      }
      if (!registeredPids(servicePath).includes(pid)) {
        return { ok: false, reason: "the connected server is not the managed background service" };
      }
      return { ok: true };
    },
  };
}
