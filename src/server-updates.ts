import { createSignal } from "solid-js";
import {
  errorMessage,
  isUpdateAvailable,
  mapPool,
  withTimeout,
  type FetchLatest,
} from "./checker.ts";
import type { DurableState } from "./durable-state.ts";
import { classifyPluginSpec } from "./plugins.ts";
import type { InventoryPlugin, InventoryPort } from "./server-inventory.ts";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_TIMEOUT_MS = 5000;
export const REGISTRY_CONCURRENCY = 4;
// A new key: V1 state is never read, migrated, or acted on.
export const STORAGE_KEY = "plugin-updates.v2";
export const STORAGE_VERSION = 2;

export type ServerRowStatus = "update" | "current" | "unknown" | "pinned" | "skipped";

export interface ServerRow {
  id: string;
  spec: string;
  name: string;
  status: ServerRowStatus;
  installedVersion?: string;
  latestVersion?: string;
  pinnedVersion?: string;
  reason?: string;
  failed?: string;
}

export interface StoredServerState {
  version: number;
  /** Connected-server/location identity the snapshot was checked for. */
  environment: string;
  /** Epoch milliseconds of the last complete cycle; 0 until one succeeds. */
  checkedAt: number;
  inventoryKey: string;
  rows: ServerRow[];
}

export const EMPTY_SERVER_STATE: StoredServerState = {
  version: STORAGE_VERSION,
  environment: "",
  checkedAt: 0,
  inventoryKey: "",
  rows: [],
};

/** Row identity for a package target; the apply model records outcomes by it. */
export function packageRowId(target: string): string {
  return `package:${target}`;
}

export type Freshness = "fresh" | "stale";

export interface ServerUpdatesOptions {
  readonly inventory: InventoryPort;
  readonly state: DurableState<StoredServerState>;
  readonly environment: () => string;
  readonly fetchLatest: FetchLatest;
  readonly now?: () => number;
  readonly toast?: (message: string) => void;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

export interface ServerUpdates {
  rows(): readonly ServerRow[];
  checking(): boolean;
  freshness(): Freshness;
  error(): string;
  checkFailed(): boolean;
  updateCount(): number;
  /** Automatic cycle: honours the 24h TTL and may toast. */
  start(): Promise<boolean>;
  /** Manual cycle: ignores the TTL and never toasts. */
  refresh(): Promise<boolean>;
  /**
   * Post-update re-read: lets any in-flight cycle drain, then runs a manual
   * cycle so the rows reflect the operation just applied. Resolves to whether
   * the fresh inventory was actually read.
   */
  reread(): Promise<boolean>;
  dispose(): void;
}

interface Checkable {
  row: ServerRow;
  name: string;
  outdated: boolean;
}

interface Composed {
  rows: ServerRow[];
  attempted: number;
  failed: number;
  updates: number;
}

function inventoryKey(entries: readonly InventoryPlugin[]): string {
  const identities = entries.flatMap((entry) => {
    switch (entry.source.type) {
      case "package":
        return [`package:${entry.source.target}`];
      case "local":
        return [`local:${entry.source.path}`];
      case "sdk":
        return [`sdk:${entry.id ?? ""}`];
      case "builtin":
        return [];
    }
  });
  return [...new Set(identities)].sort().join("\n");
}

async function composeRows(
  entries: readonly InventoryPlugin[],
  options: {
    fetchLatest: FetchLatest;
    timeoutMs: number;
    concurrency: number;
    signal: AbortSignal;
    hostChecked: boolean;
  },
): Promise<Composed> {
  const rows: ServerRow[] = [];
  const checkable: Checkable[] = [];

  for (const entry of entries) {
    if (entry.source.type === "builtin") continue;
    const failure = entry.failed === undefined ? {} : { failed: entry.failed };
    if (entry.source.type === "local") {
      rows.push({
        id: `local:${entry.source.path}`,
        spec: entry.source.path,
        name: entry.id ?? entry.source.path,
        status: "skipped",
        reason: "local path",
        ...failure,
      });
      continue;
    }
    if (entry.source.type === "sdk") {
      const id = entry.id ?? "sdk";
      rows.push({
        id: `sdk:${id}`,
        spec: id,
        name: id,
        status: "skipped",
        reason: "sdk plugin",
        ...failure,
      });
      continue;
    }

    const target = entry.source.target;
    const common = {
      id: packageRowId(target),
      spec: target,
      ...(entry.source.version === undefined ? {} : { installedVersion: entry.source.version }),
      ...failure,
    };
    const classification = classifyPluginSpec(target);
    if (classification.kind === "unsupported") {
      rows.push({ ...common, name: target, status: "skipped", reason: classification.reason });
    } else if (classification.kind === "pinned") {
      rows.push({
        ...common,
        name: classification.name,
        status: "pinned",
        pinnedVersion: classification.version,
      });
    } else {
      const row: ServerRow = { ...common, name: classification.name, status: "unknown" };
      rows.push(row);
      checkable.push({ row, name: classification.name, outdated: entry.source.outdated });
    }
  }

  let attempted = 0;
  let failed = 0;
  let updates = 0;
  await mapPool(checkable, options.concurrency, async (item) => {
    attempted++;
    let latestVersion: string | undefined;
    let lookupFailed = false;
    try {
      latestVersion = (
        await withTimeout(options.fetchLatest(item.name, { signal: options.signal }), options.timeoutMs)
      ).version;
    } catch {
      lookupFailed = true;
      failed++;
    }
    if (latestVersion !== undefined) item.row.latestVersion = latestVersion;

    if (item.outdated) {
      updates++;
      item.row.status = "update";
      return;
    }
    const comparison = isUpdateAvailable(item.row.installedVersion, latestVersion);
    if (comparison === false) {
      item.row.status = "current";
      return;
    }
    item.row.status = "unknown";
    item.row.reason =
      comparison === true ?
        options.hostChecked ? "host check did not confirm the update" : "host check unavailable"
      : lookupFailed ? "registry lookup failed"
      : item.row.installedVersion === undefined ? "installed version unavailable"
      : "version not parseable";
  });

  return { rows, attempted, failed, updates };
}

export function updatesToastMessage(count: number): string {
  return `${count} OpenCode updates available. Run /plugin-updates to review them.`;
}

export function createServerUpdates(options: ServerUpdatesOptions): ServerUpdates {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const concurrency = options.concurrency ?? REGISTRY_CONCURRENCY;
  const toast = options.toast ?? (() => {});

  const [rows, setRows] = createSignal<readonly ServerRow[]>([]);
  const [checking, setChecking] = createSignal(false);
  const [freshness, setFreshness] = createSignal<Freshness>("stale");
  const [error, setError] = createSignal("");
  const [checkFailed, setCheckFailed] = createSignal(false);

  const controller = new AbortController();
  let disposed = false;
  let cycle: Promise<boolean> | undefined;

  async function runCycle(manual: boolean): Promise<boolean> {
    if (disposed) return false;
    setChecking(true);
    try {
      const environment = options.environment();
      const stored = options.state.read();
      const storedHere = stored.version === STORAGE_VERSION && stored.environment === environment;
      if (storedHere && stored.rows.length > 0) setRows(stored.rows);

      let entries: readonly InventoryPlugin[];
      try {
        entries = await options.inventory.list(controller.signal);
      } catch (reason) {
        if (disposed) return false;
        setError(errorMessage(reason));
        setFreshness("stale");
        return false;
      }
      if (disposed) return false;
      setError("");

      const key = inventoryKey(entries);
      const fresh =
        !manual &&
        storedHere &&
        stored.checkedAt > 0 &&
        now() - stored.checkedAt < CHECK_INTERVAL_MS &&
        stored.inventoryKey === key;
      if (fresh) {
        setRows(stored.rows);
        setFreshness("fresh");
        setCheckFailed(false);
        return true;
      }

      let checked: readonly InventoryPlugin[] | undefined;
      let hostChecked = true;
      if (entries.some((entry) => entry.source.type === "package")) {
        try {
          checked = await options.inventory.check(controller.signal);
        } catch {
          hostChecked = false;
        }
        if (disposed) return false;
      }

      const composed = await composeRows(checked ?? entries, {
        fetchLatest: options.fetchLatest,
        timeoutMs,
        concurrency,
        signal: controller.signal,
        hostChecked,
      });
      if (disposed) return false;

      setRows(composed.rows);
      setCheckFailed(!hostChecked);
      // Without one observed registry version or host-confirmed update the
      // cycle carries no evidence: keep the TTL stale so the next start retries.
      const complete =
        hostChecked && (composed.attempted === 0 || composed.failed < composed.attempted || composed.updates > 0);
      setFreshness(complete ? "fresh" : "stale");
      try {
        await options.state.write({
          version: STORAGE_VERSION,
          environment,
          checkedAt: complete ? now() : 0,
          inventoryKey: key,
          rows: composed.rows,
        });
      } catch {
        // Durable state is best-effort; the in-memory cycle result still renders.
      }
      if (disposed) return false;
      if (!manual && complete && composed.updates > 0) toast(updatesToastMessage(composed.updates));
      return true;
    } catch (reason) {
      if (!disposed) {
        setError(errorMessage(reason));
        setFreshness("stale");
      }
      return false;
    } finally {
      if (!disposed) setChecking(false);
    }
  }

  function run(manual: boolean): Promise<boolean> {
    if (cycle !== undefined) return cycle;
    cycle = (async () => {
      try {
        // Keep the caller's current tick free of network work.
        await Promise.resolve();
        return await runCycle(manual);
      } catch {
        // runCycle isolates its own failures; this only keeps the shared promise from rejecting.
        return false;
      } finally {
        cycle = undefined;
      }
    })();
    return cycle;
  }

  return {
    rows,
    checking,
    freshness,
    error,
    checkFailed,
    updateCount: () => rows().filter((row) => row.status === "update").length,
    start: () => run(false),
    refresh: () => run(true),
    async reread() {
      // A cycle that started before the updates applied carries their old
      // inventory; drain it so this re-read starts after the operation.
      while (cycle !== undefined) await cycle;
      return run(true);
    },
    dispose() {
      disposed = true;
      controller.abort();
    },
  };
}
