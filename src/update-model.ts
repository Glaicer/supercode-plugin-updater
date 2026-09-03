/**
 * Per-package registry failures become unknown candidates. A cycle where
 * every attempted lookup fails is not persisted, allowing the next start to
 * retry rather than waiting for the normal check interval. Consuming pending
 * invalidations erases the last check so the start after an applied update
 * re-runs the cycle instead of serving the pre-update snapshot.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  createNpmRegistryPort,
  isUpdateAvailable,
  type FetchLatest,
} from "./checker.ts";
import { defaultCacheRoot, createPackageCache, type PackageCache, type PackageKind } from "./cache.ts";
import { classifyPluginSpec } from "./plugins.ts";
import { createUpdateState, isPendingEntry } from "./state.ts";
import { MANAGED_TOOLS } from "./tools.ts";

export const REGISTRY_TIMEOUT_MS = 5000;
export const REGISTRY_CONCURRENCY = 4;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PREPARED_TOAST_MESSAGE = "Updates prepared. Restart OpenCode to apply them.";

export type UpdateCandidateStatus = "checked" | "pinned" | "unknown";

export interface UpdateCandidate {
  kind: PackageKind;
  // Plugins retain the exact config spec; tools use their package name.
  spec: string;
  name: string;
  status: UpdateCandidateStatus;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  pinnedVersion?: string;
  reason?: string;
}

export interface SkippedSpec {
  kind: "plugin";
  spec: string;
  reason: string;
}

export interface CheckResult {
  candidates: readonly UpdateCandidate[];
  skipped: readonly SkippedSpec[];
}

/**
 * The same package may appear as both a plugin and a tool because each kind
 * resolves to a different cache directory.
 */
export interface PendingInvalidationEntry {
  kind: PackageKind;
  spec: string;
}

export type UpdateModelState = "idle" | "updates-available" | "pending-restart" | "cache-invalidated";

export interface UpdateModel {
  /**
   * Runs a manual cycle without the TTL or toast. A successful cycle updates
   * the persisted snapshot and last-check time.
   */
  runCheck(): Promise<CheckResult>;
  /**
   * Drains pending invalidations before deciding whether the persisted check
   * time is stale. Concurrent calls share the same start operation.
   */
  start(): Promise<void>;
  getSnapshot(): CheckResult | undefined;
  /**
   * Persists selections for invalidation during disposal; it never changes
   * the filesystem synchronously.
   */
  confirm(selection: readonly PendingInvalidationEntry[]): void;
  state: UpdateModelState;
}

export interface UpdateModelOptions {
  fetchLatest?: FetchLatest;
  cacheRoot?: string;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

/**
 * Plugin entries in both opencode.json (`api.state.config.plugin`) and
 * tui.json (`api.tuiConfig.plugin`) can be a bare spec string or a
 * `[spec, options]` tuple. Anything else is ignored defensively.
 */
function normalizePluginEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const specs: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      specs.push(entry);
    } else if (Array.isArray(entry) && typeof entry[0] === "string") {
      specs.push(entry[0]);
    }
  }
  return specs;
}

/**
 * Union of opencode.json and tui.json plugin specs, deduplicated by exact
 * spec string. Server entries come first so a shared spec keeps its
 * first-seen position.
 */
function collectPluginSpecs(api: TuiPluginApi): string[] {
  const server = normalizePluginEntries(api.state.config.plugin);
  const tui = normalizePluginEntries(
    (api.tuiConfig as { plugin?: unknown } | undefined)?.plugin,
  );
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const spec of [...server, ...tui]) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    merged.push(spec);
  }
  return merged;
}

function sameSpecs(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((spec, index) => spec === b[index]);
}

async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  fn: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as Item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function withTimeout<Value>(promise: Promise<Value>, ms: number): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`registry timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createUpdateModel(api: TuiPluginApi, options: UpdateModelOptions = {}): UpdateModel {
  const fetchLatest = options.fetchLatest ?? createNpmRegistryPort();
  const cache: PackageCache = createPackageCache(options.cacheRoot ?? defaultCacheRoot());
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const concurrency = options.concurrency ?? REGISTRY_CONCURRENCY;
  const state = createUpdateState(api.kv);
  const now = options.now ?? Date.now;

  async function runCycle(): Promise<CheckResult> {
    const specs = collectPluginSpecs(api);

    const classified = specs.map((spec) => ({ spec, classification: classifyPluginSpec(spec) }));
    const skipped: SkippedSpec[] = [];
    const pinned: UpdateCandidate[] = [];
    const checkable: { kind: PackageKind; spec: string; name: string }[] = [];

    for (const { spec, classification } of classified) {
      if (classification.kind === "unsupported") {
        skipped.push({ kind: "plugin", spec, reason: classification.reason });
      } else if (classification.kind === "pinned") {
        pinned.push({
          kind: "plugin",
          spec,
          name: classification.name,
          status: "pinned",
          pinnedVersion: classification.version,
        });
      } else {
        checkable.push({ kind: "plugin", spec, name: classification.name });
      }
    }

    for (const name of MANAGED_TOOLS) {
      if (cache.hasTool(name)) checkable.push({ kind: "tool", spec: name, name });
    }

    let attempted = 0;
    let failed = 0;
    const checked = await mapPool(checkable, concurrency, async (entry) => {
      const base = { kind: entry.kind, spec: entry.spec, name: entry.name };

      if (entry.kind === "plugin" && !cache.has(entry.name)) {
        return { ...base, status: "unknown" as const, reason: "not in cache" };
      }

      const installedVersion =
        entry.kind === "tool" ?
          cache.getInstalledToolVersion(entry.name)
        : cache.getInstalledVersion(entry.name);

      attempted++;
      let latestVersion: string | undefined;
      let lookupFailed = false;
      try {
        latestVersion = (await withTimeout(fetchLatest(entry.name), timeoutMs)).version;
      } catch {
        lookupFailed = true;
        failed++;
      }

      const updateAvailable = isUpdateAvailable(installedVersion, latestVersion);
      if (updateAvailable === undefined) {
        return {
          ...base,
          status: "unknown" as const,
          installedVersion,
          latestVersion,
          reason: lookupFailed ? "registry lookup failed" : "version not parseable",
        };
      }
      // A defined comparison proves both versions parsed successfully.
      return {
        ...base,
        status: "checked" as const,
        installedVersion: installedVersion as string,
        latestVersion: latestVersion as string,
        updateAvailable,
      };
    });

    const result: CheckResult = { candidates: [...pinned, ...checked], skipped };

    const registryDown = attempted > 0 && failed === attempted;
    if (!registryDown) {
      state.setLastCheck(now());
      state.setAvailable(result);
      state.setCheckedPluginSpecs(specs);
    }
    // A later check must not undo a confirmed or partially consumed marker.
    if (modelState === "idle" || modelState === "updates-available") {
      modelState =
        result.candidates.some((candidate) => candidate.updateAvailable === true)
          ? "updates-available"
          : "idle";
    }
    return result;
  }

  let inFlightStart: Promise<void> | undefined;
  let modelState: UpdateModelState = "idle";

  function confirm(selection: readonly PendingInvalidationEntry[]): void {
    const entries = selection.filter(isPendingEntry);
    if (entries.length === 0) return;
    // Re-confirming must not discard entries still awaiting invalidation.
    const merged = state.getPending() ?? [];
    for (const entry of entries) {
      if (!merged.some((marked) => marked.kind === entry.kind && marked.spec === entry.spec)) {
        merged.push(entry);
      }
    }
    state.setPending(merged);
    modelState = "pending-restart";
    api.ui.toast({ message: PREPARED_TOAST_MESSAGE });
  }

  function consumeEntry(entry: PendingInvalidationEntry): boolean {
    try {
      if (entry.kind === "tool") {
        cache.removeKeyDir("tool", entry.spec);
        return true;
      }
      const classification = classifyPluginSpec(entry.spec);
      if (classification.kind === "floating") {
        cache.removeKeyDir("plugin", classification.name);
      }
      return true;
    } catch {
      return false;
    }
  }

  function drainPending(): boolean {
    const entries = state.getPending();
    if (!entries || entries.length === 0) return false;
    modelState = "cache-invalidated";
    let remaining = [...entries];
    let consumed = false;
    for (const entry of entries) {
      if (!consumeEntry(entry)) continue;
      consumed = true;
      remaining = remaining.filter((candidate) => candidate !== entry);
      state.setPending(remaining.length > 0 ? remaining : null);
    }
    if (remaining.length === 0) modelState = "idle";
    // Consumed entries change the installed set, so the stored check no longer
    // describes the cache; erasing lastCheck makes the next start re-run the
    // cycle instead of serving the pre-update snapshot.
    if (consumed) state.clearLastCheck();
    return consumed;
  }

  api.lifecycle.onDispose(() => {
    drainPending();
  });

  return {
    runCheck: () => runCycle(),
    start(): Promise<void> {
      inFlightStart ??= decideAndCycle().finally(() => {
        inFlightStart = undefined;
      });
      return inFlightStart;
    },
    getSnapshot: () => state.getAvailable(),
    confirm,
    get state(): UpdateModelState {
      return modelState;
    },
  };

  async function decideAndCycle(): Promise<void> {
      // Keep start non-blocking through the caller's current tick.
      await Promise.resolve();
      drainPending();
      const lastCheck = state.getLastCheck();
      const pluginSpecs = collectPluginSpecs(api);
      if (
        typeof lastCheck === "number" &&
        now() - lastCheck < CHECK_INTERVAL_MS &&
        sameSpecs(state.getCheckedPluginSpecs(), pluginSpecs)
      ) return;
      const result = await runCycle();
      const updates = result.candidates.filter((c) => c.updateAvailable === true).length;
      if (updates > 0) {
        api.ui.toast({ message: `${updates} OpenCode updates available. Run /plugin-updates to review them.` });
      }
  }
}
