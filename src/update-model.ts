/**
 * Update Model — the whole check cycle as one seam, created from a
 * `TuiPluginApi`. Classifies effective-config plugin specs, intersects the
 * known Managed Tool set with existing cache dirs, reads installed versions
 * from the package cache, asks the injected registry port for `latest`, and
 * emits ready-to-render Update Candidates plus skipped specs.
 *
 * Registry orchestration lives here so tests can observe it through the seam:
 * every port call is cut by a per-request timeout and flows through a
 * fixed-size pool; a failure of one package (rejection, timeout, unparsable
 * version) isolates to that candidate's `unknown` status and never breaks the
 * cycle. Registry is asked only for installed packages — a floating spec
 * whose cache dir exists, or a known tool whose cache dir exists. Tools and
 * plugins share one candidate path; only their cache key dirs differ.
 *
 * Cycle policy: a completed cycle (per-package failures isolated to unknowns)
 * counts as successful and moves `lastCheck` + overwrites `available` in the
 * machine-global `plugin-updates.*` state, whether auto or manual. Only when
 * lookups were attempted and every one failed is the registry unreachable —
 * that cycle does not count: nothing is persisted, the next start retries.
 * `start()` is the start-time decision: absent or ≥24h-old `lastCheck` runs
 * one cycle and toasts once when updates exist; a fresh one skips silently.
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

/** Per-request timeout for registry lookups (US 30). */
export const REGISTRY_TIMEOUT_MS = 5000;
/** Fixed pool size for concurrent registry lookups (US 31). */
export const REGISTRY_CONCURRENCY = 4;
/** Minimum period between counted check cycles (US 1). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The one prepared toast per confirm (US 18) — reused verbatim by the screen's pending banner. */
export const PREPARED_TOAST_MESSAGE = "Updates prepared. Restart OpenCode to apply them.";

export type UpdateCandidateStatus = "checked" | "pinned" | "unknown";

export interface UpdateCandidate {
  kind: PackageKind;
  /**
   * For plugins: the spec exactly as it appeared in the effective config.
   * For tools: the package name — the spec OpenCode installs it by.
   */
  spec: string;
  name: string;
  status: UpdateCandidateStatus;
  /** From the cache manifest; absent means unknown, not "not installed". */
  installedVersion?: string;
  /** From the registry port; absent when unknown or never fetched. */
  latestVersion?: string;
  /** Set only when both versions are known — the checkbox-able class. */
  updateAvailable?: boolean;
  /** Pinned Spec candidates only: the exact version pinned in config. */
  pinnedVersion?: string;
  /** Why the status is `unknown` — data for the future status column. */
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
 * One entry of the Pending Invalidation marker: a confirmed selection.
 * The same package may legitimately appear twice — as a plugin (its cache
 * key dir carries the `@latest` suffix) and as a tool (bare-name key dir);
 * each kind resolves its own directory.
 */
export interface PendingInvalidationEntry {
  kind: PackageKind;
  spec: string;
}

/**
 * The Pending Invalidation state machine: `idle` (nothing confirmed),
 * `updates-available` (a counted cycle found updates), `pending-restart`
 * (a confirmed marker exists), `cache-invalidated` (the marker was drained
 * by dispose or recovery), back to `idle`.
 */
export type UpdateModelState = "idle" | "updates-available" | "pending-restart" | "cache-invalidated";

export interface UpdateModel {
  /**
   * One check cycle, ignoring the 24h TTL — the screen's manual refresh. On
   * a counted cycle it moves `lastCheck` and overwrites `available`; when
   * the registry is down entirely nothing is persisted. Never toasts — the
   * result is visible in the open screen.
   */
  runCheck(): Promise<CheckResult>;
  /**
   * The start-time decision (US 1, 3): asynchronous and non-blocking. An
   * absent or ≥24h-old `lastCheck` runs one cycle and toasts exactly once
   * when updates exist; a fresh one skips the cycle — and any toast. Before
   * the TTL decision, a non-empty Pending Invalidation marker is drained
   * (recovery): stale `lastCheck` cannot delay it, freshness cannot mask it.
   * A failed cycle (registry down entirely) toasts nothing and persists
   * nothing, so the next start retries.
   */
  start(): Promise<void>;
  /**
   * The snapshot of the last successful cycle, read from state without
   * registry traffic (US 29); `undefined` before the first success.
   */
  getSnapshot(): CheckResult | undefined;
  /**
   * Confirm the screen's selection (after the host's confirm dialog): the
   * list becomes the Pending Invalidation marker in kv and one prepared
   * toast is emitted. Nothing on the filesystem changes — deletion happens
   * only in dispose (ADR 0016). An empty selection does nothing.
   */
  confirm(selection: readonly PendingInvalidationEntry[]): void;
  /** Current Pending Invalidation state machine position (observable seam). */
  state: UpdateModelState;
}

export interface UpdateModelOptions {
  /** Registry port; defaults to the npm registry port from checker. */
  fetchLatest?: FetchLatest;
  /** Package cache root; defaults to `~/.cache/opencode/packages`. */
  cacheRoot?: string;
  /** Per-request timeout in ms; default `REGISTRY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Pool size for registry lookups; default `REGISTRY_CONCURRENCY`. */
  concurrency?: number;
  /** Clock for the TTL decision and `lastCheck` stamps; default `Date.now`. */
  now?: () => number;
}

/** Runs `fn` over `items` through a fixed-size pool; order is preserved. */
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

/** Rejects if the underlying promise neither settles within `ms`. */
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
    const entries = api.state.config.plugin;
    const specs =
      Array.isArray(entries) ?
        entries.filter((entry): entry is string => typeof entry === "string")
      : [];

    const classified = specs.map((spec) => ({ spec, classification: classifyPluginSpec(spec) }));
    const skipped: SkippedSpec[] = [];
    const pinned: UpdateCandidate[] = [];
    const checkable: { kind: PackageKind; spec: string; name: string }[] = [];

    for (const { spec, classification } of classified) {
      if (classification.kind === "unsupported") {
        skipped.push({ kind: "plugin", spec, reason: classification.reason });
      } else if (classification.kind === "pinned") {
        // Info-only: the badge shows the configured pin. No registry call,
        // no comparison — by definition there is nothing to update to.
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

    // US 25: only installed tools are checked — the known set ∩ existing
    // cache dirs. A known-but-absent name produces no candidate at all,
    // and foreign cache content is never reached.
    for (const name of MANAGED_TOOLS) {
      if (cache.hasTool(name)) checkable.push({ kind: "tool", spec: name, name });
    }

    let attempted = 0;
    let failed = 0;
    const checked = await mapPool(checkable, concurrency, async (entry) => {
      const base = { kind: entry.kind, spec: entry.spec, name: entry.name };

      // US 25: no registry traffic for plugins that are not installed.
      // (Tools were gated by `hasTool` before the pool: absent known names
      // produce no candidate at all.)
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
      // `updateAvailable` is defined only when both versions parsed, so
      // both are strings here — that invariant replaces any assertion.
      return {
        ...base,
        status: "checked" as const,
        installedVersion: installedVersion as string,
        latestVersion: latestVersion as string,
        updateAvailable,
      };
    });

    const result: CheckResult = { candidates: [...pinned, ...checked], skipped };

    // Failure policy: per-package failures isolate to `unknown` above and
    // the cycle counts as completed. Only when lookups were attempted and
    // every one of them failed is the registry unreachable as a whole — the
    // cycle does not count: `lastCheck` and `available` stay, so the next
    // start retries (US 22, 23).
    const registryDown = attempted > 0 && failed === attempted;
    if (!registryDown) {
      state.setLastCheck(now());
      state.setAvailable(result);
    }
    // The machine only tracks discovery while nothing is marked: idle ↔
    // updates-available. A marker (pending-restart) or a begun invalidation
    // (cache-invalidated) is sticky — a later cycle result, auto or manual,
    // cannot un-confirm what the user already confirmed.
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

  /**
   * Confirm the screen's selection (after the host's confirm dialog): the
   * entries merge into the Pending Invalidation marker in kv and one
   * prepared toast is emitted. Merging — never overwriting — so a second
   * confirm in the same session cannot drop a selection that dispose has
   * not consumed yet, and a failed-entry retry survives re-confirms.
   * Nothing on the filesystem changes: deletion happens only in dispose
   * (ADR 0016). An empty selection does nothing.
   */
  function confirm(selection: readonly PendingInvalidationEntry[]): void {
    const entries = selection.filter(isPendingEntry);
    if (entries.length === 0) return;
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

  /**
   * Consumes one marker entry: resolves the spec to its key dir and removes
   * only that dir. A plugin entry resolves via the floating-spec name (the
   * resolver's `<name>@latest` dir); a tool entry is its own bare-name dir.
   * Anything that does not resolve to a removable dir is consumed without
   * touching the filesystem — a marker no candidate could have produced.
   * Best-effort: a removal failure leaves the entry for the retry at the
   * next start (US 21) and never escapes.
   */
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

  /**
   * Drains the Pending Invalidation marker element-wise: remove a dir, then
   * erase that entry from kv — never the cache as a whole (US 26). Ends
   * with a `null` marker when everything is consumed. Runs both from the
   * dispose callback and from recovery at start.
   */
  function drainPending(): void {
    const entries = state.getPending();
    if (!entries || entries.length === 0) return;
    modelState = "cache-invalidated";
    let remaining = [...entries];
    for (const entry of entries) {
      if (!consumeEntry(entry)) continue;
      remaining = remaining.filter((candidate) => candidate !== entry);
      state.setPending(remaining.length > 0 ? remaining : null);
    }
    if (remaining.length === 0) modelState = "idle";
  }

  api.lifecycle.onDispose(() => {
    drainPending();
  });

  return {
    runCheck: () => runCycle(),
    start(): Promise<void> {
      // One auto cycle per model at a time: overlapping starts would share
      // the same stale `lastCheck` read and toast twice.
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
      // The decision is asynchronous (US 3): yield before touching state,
      // the cache, or the registry so a synchronous start never blocks or
      // reaches the network within the caller's tick.
      await Promise.resolve();
      // Recovery first (US 21): a marker left by a previous process is
      // drained before the TTL decision — invalidation depends on the
      // filesystem, not on `lastCheck` freshness (the reinstall race this
      // may lose is accepted by ADR 0016).
      drainPending();
      const lastCheck = state.getLastCheck();
      // Fresh (`< 24h`) → skip; absent, corrupt, or ≥24h old → one cycle.
      if (typeof lastCheck === "number" && now() - lastCheck < CHECK_INTERVAL_MS) return;
      const result = await runCycle();
      // Pinned/unknown candidates never carry the flag, and a failed cycle
      // has only unknowns, so this is also where the "no toast for a failed
      // cycle" rule lands.
      const updates = result.candidates.filter((c) => c.updateAvailable === true).length;
      if (updates > 0) {
        api.ui.toast({ message: `${updates} OpenCode updates available. Run /plugin-updates to review them.` });
      }
  }
}
