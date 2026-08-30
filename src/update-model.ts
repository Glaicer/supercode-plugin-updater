/**
 * Update Model — the whole check cycle as one seam, created from a
 * `TuiPluginApi`. Classifies effective-config plugin specs, reads installed
 * versions from the package cache, asks the injected registry port for
 * `latest`, and emits ready-to-render Update Candidates plus skipped specs.
 *
 * Registry orchestration lives here so tests can observe it through the seam:
 * every port call is cut by a per-request timeout and flows through a
 * fixed-size pool; a failure of one package (rejection, timeout, unparsable
 * version) isolates to that candidate's `unknown` status and never breaks the
 * cycle. Registry is asked only for packages whose cache dir exists.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  createNpmRegistryPort,
  isUpdateAvailable,
  type FetchLatest,
} from "./checker.ts";
import { defaultCacheRoot, createPackageCache, type PackageCache } from "./cache.ts";
import { classifyPluginSpec } from "./plugins.ts";

/** Per-request timeout for registry lookups (US 30). */
export const REGISTRY_TIMEOUT_MS = 5000;
/** Fixed pool size for concurrent registry lookups (US 31). */
export const REGISTRY_CONCURRENCY = 4;

export type UpdateCandidateStatus = "checked" | "pinned" | "unknown";

export interface UpdateCandidate {
  kind: "plugin";
  /** The spec exactly as it appeared in the effective config. */
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

export interface UpdateModel {
  /** One check cycle. Resolves even when every lookup failed. */
  runCheck(): Promise<CheckResult>;
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

  return {
    async runCheck(): Promise<CheckResult> {
      const entries = api.state.config.plugin;
      const specs =
        Array.isArray(entries) ?
          entries.filter((entry): entry is string => typeof entry === "string")
        : [];

      const classified = specs.map((spec) => ({ spec, classification: classifyPluginSpec(spec) }));
      const skipped: SkippedSpec[] = [];
      const floating: { spec: string; name: string }[] = [];
      const pinned: UpdateCandidate[] = [];

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
          floating.push({ spec, name: classification.name });
        }
      }

      const floatingResults = await mapPool(floating, concurrency, async (entry) => {
        const base = { kind: "plugin" as const, spec: entry.spec, name: entry.name };

        if (!cache.has(entry.name)) {
          // US 25: no registry traffic for packages that are not installed.
          return { ...base, status: "unknown" as const, reason: "not in cache" };
        }

        const installedVersion = cache.getInstalledVersion(entry.name);
        let latestVersion: string | undefined;
        let failed = false;
        try {
          latestVersion = (await withTimeout(fetchLatest(entry.name), timeoutMs)).version;
        } catch {
          failed = true;
        }

        const updateAvailable = isUpdateAvailable(installedVersion, latestVersion);
        if (updateAvailable === undefined) {
          return {
            ...base,
            status: "unknown" as const,
            installedVersion,
            latestVersion,
            reason: failed ? "registry lookup failed" : "version not parseable",
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

      // Within each status class the config order is preserved; the future
      // screen groups by class, so global interleaving does not matter.
      return { candidates: [...pinned, ...floatingResults], skipped };
    },
  };
}
