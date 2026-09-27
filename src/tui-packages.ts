import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPluginSpec } from "./plugins.ts";

export interface CliUpdateResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the standard CLI for exactly one target. The connected location is the
 * cwd, which is how the CLI binds its Server half to the same server and
 * location the TUI is connected to (live-proven: service registration + cwd).
 */
export type CliUpdateRunner = (
  target: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<CliUpdateResult>;

export interface TuiPackagePort {
  /**
   * Targets configured for the TUI runtime (cli.json), minus enablement
   * directives. Local paths and other unupdatable specs stay in so the screen
   * can show them as skipped.
   */
  cliTargets(): readonly string[];
  /** Version of the newest installed npm generation, or undefined when absent. */
  installedVersion(target: string): string | undefined;
  /** Whether the installed generation exposes the ./tui entrypoint. */
  exposesTui(target: string): boolean;
}

function configDirectory(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  );
}

function cacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode");
}

/**
 * Enablement directives select or disable loaded plugins; they name no
 * installable package. The CLI applies the same exclusions.
 */
function isDirective(target: string): boolean {
  return target.startsWith("-") || target === "*" || target.endsWith(".*") || target.startsWith("opencode.");
}

function readCliTargets(configDir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(configDir, "cli.json"), "utf8");
  } catch {
    return [];
  }
  // The CLI config is JSONC-tolerant on the host side; a commented file parses
  // as nothing here and simply contributes no TUI rows.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return [];
  const targets: string[] = [];
  for (const entry of plugins) {
    const target = typeof entry === "string" ? entry : (entry as { package?: unknown })?.package;
    if (typeof target !== "string" || isDirective(target)) continue;
    targets.push(target);
  }
  return [...new Set(targets)];
}

function latestGeneration(directory: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  const generations = entries.filter((entry) => /^\d+$/.test(entry)).toSorted((a, b) => Number(a) - Number(b));
  return generations.at(-1);
}

interface Manifest {
  version?: unknown;
  exports?: unknown;
}

function readManifest(path: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

export function createTuiPackagePort(roots: { configDir?: string; cacheDir?: string } = {}): TuiPackagePort {
  const configDir = roots.configDir ?? configDirectory();
  const cacheDir = roots.cacheDir ?? cacheDirectory();

  const resolveGeneration = (target: string): { directory: string; name: string } | undefined => {
    const classification = classifyPluginSpec(target);
    if (classification.kind === "unsupported") return undefined;
    const spec = classification.kind === "floating" ? "latest" : classification.version;
    const directory = join(cacheDir, "npm", `${classification.name}@${spec}`);
    const generation = latestGeneration(directory);
    if (generation === undefined) return undefined;
    return { directory: join(directory, generation), name: classification.name };
  };

  return {
    cliTargets: () => readCliTargets(configDir),
    installedVersion(target) {
      const generation = resolveGeneration(target);
      if (generation === undefined) return undefined;
      const manifest = readManifest(join(generation.directory, "node_modules", generation.name, "package.json"));
      return typeof manifest?.version === "string" ? manifest.version : undefined;
    },
    exposesTui(target) {
      const generation = resolveGeneration(target);
      if (generation === undefined) return false;
      const root = join(generation.directory, "node_modules", generation.name);
      const manifest = readManifest(join(root, "package.json"));
      if (manifest === undefined) return false;
      if (manifest.exports === undefined) {
        // Legacy layout without an exports map: the host resolves pkg/tui as a file.
        return ["tui.js", "tui.ts", "tui/index.js"].some((entry) => existsSync(join(root, entry)));
      }
      return typeof manifest.exports === "object" && manifest.exports !== null && "./tui" in manifest.exports;
    },
  };
}

export function createCliUpdateRunner(): CliUpdateRunner {
  return (target, cwd, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn("opencode", ["plugin", "update", target], {
        cwd,
        signal,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}
