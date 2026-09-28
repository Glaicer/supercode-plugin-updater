import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { managedToolCacheDir } from "./managed-tools.ts";
import { validatedToolNames } from "./tool-reinstall.ts";

export interface Invalidations {
  removed: string[];
  failed: { name: string; error: string }[];
}

export interface SupervisorDeps {
  /** Run `opencode service stop`; resolve to its exit code. */
  stop(): Promise<number>;
  /** Whether the target process is confirmed stopped (no longer live). */
  isStopped(pid: number): boolean;
  /** Remove the cache of the selected tools; report per-tool success. */
  invalidate(names: readonly string[]): Invalidations;
  /** Run `opencode service start`; resolve to its exit code. */
  start(): Promise<number>;
}

export interface SequenceResult {
  /** The connected server was stopped and confirmed stopped. */
  stopOk: boolean;
  /** Per-tool invalidation result, or null when skipped because the stop failed. */
  invalidated: Invalidations | null;
  /** The server was brought back up. */
  started: boolean;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The whole reinstall step, owned by a detached child so the final `start` never
 * depends on the TUI handler that launched it. The order is mandatory:
 * stop -> confirm stopped -> invalidate -> start. The cache is never touched
 * unless the target server is confirmed stopped, and the server is always
 * brought back up even when invalidation fails part-way.
 */
export async function runSequence(pid: number, names: readonly string[], deps: SupervisorDeps): Promise<SequenceResult> {
  let stopOk = false;
  try {
    const code = await deps.stop();
    stopOk = code === 0 && deps.isStopped(pid);
  } catch {
    stopOk = false;
  }

  let invalidated: Invalidations | null = null;
  if (stopOk) {
    try {
      invalidated = deps.invalidate(names);
    } catch (reason) {
      invalidated = { removed: [], failed: names.map((name) => ({ name, error: message(reason) })) };
    }
  }

  let started = false;
  try {
    started = (await deps.start()) === 0;
  } catch {
    started = false;
  }
  return { stopOk, invalidated, started };
}

/**
 * Remove every generation of exactly the selected managed tools. The removal is
 * scoped to `<cache>/npm/<name>@latest` and nothing else — never a plugin cache,
 * another tool, or any config.
 */
export function invalidateTools(cacheDir: string, names: readonly string[]): Invalidations {
  const removed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const name of validatedToolNames(names)) {
    try {
      rmSync(managedToolCacheDir(cacheDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (reason) {
      failed.push({ name, error: message(reason) });
    }
  }
  return { removed, failed };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runCli(command: string, argv: readonly string[]): number {
  const result = spawnSync(command, [...argv], { stdio: "inherit", windowsHide: true });
  return result.status ?? -1;
}

/**
 * Whether a pid is confirmed stopped (no longer live). Signal 0 succeeds only
 * for a live process; EPERM means one owned by another user (still live), while
 * ESRCH means it is gone.
 */
export function isProcessStopped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/**
 * Detached entrypoint. Reads `--pid`, `--cache`, `--tools` (comma separated) and
 * an optional `--opencode` binary; performs the sequence and exits. Never
 * writes to the plugin's own state — the plugin reads the outcome back from the
 * cache itself.
 */
async function main(): Promise<void> {
  const pid = Number(arg("--pid"));
  const cache = arg("--cache");
  const tools = (arg("--tools") ?? "").split(",").filter((name) => name.length > 0);
  const opencode = arg("--opencode") ?? "opencode";
  if (!Number.isInteger(pid) || pid <= 0 || cache === undefined) {
    process.stderr.write("reinstall-supervisor: --pid and --cache are required\n");
    process.exitCode = 2;
    return;
  }
  await runSequence(pid, tools, {
    stop: async () => runCli(opencode, ["service", "stop"]),
    isStopped: isProcessStopped,
    invalidate: (names) => invalidateTools(cache, names),
    start: async () => runCli(opencode, ["service", "start"]),
  });
}

// Only the detached child runs the sequence; importing the module never does.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
