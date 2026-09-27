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
import type { TuiPackagePort } from "./tui-packages.ts";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_TIMEOUT_MS = 5000;
export const REGISTRY_CONCURRENCY = 4;
// A new key: V1 state is never read, migrated, or acted on.
export const STORAGE_KEY = "plugin-updates.v2";
export const STORAGE_VERSION = 2;

export type Runtime = "server" | "tui";
export type ServerRowStatus = "update" | "current" | "unknown" | "pinned" | "skipped";

export interface ServerRow {
  id: string;
  runtime: Runtime;
  spec: string;
  name: string;
  status: ServerRowStatus;
  installedVersion?: string;
  latestVersion?: string;
  pinnedVersion?: string;
  reason?: string;
  failed?: string;
  /** The same target is also loaded by the other runtime; selection covers both. */
  shared?: boolean;
  twin?: string;
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

export function tuiRowId(target: string): string {
  return `tui:${target}`;
}

export type Freshness = "fresh" | "stale";

export interface ServerUpdatesOptions {
  readonly inventory: InventoryPort;
  /** Effective local TUI package inventory (cli.json targets + installed generations). */
  readonly tui: TuiPackagePort;
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
  /**
   * The server/location environment the rows currently on screen were
   * checked against, or "" before the first successful cycle. The apply
   * compares it with the live connection before sending anything.
   */
  checkedEnvironment(): string;
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
  /** The connected server confirmed an update for the shared target. */
  outdated?: boolean;
  /** For TUI rows exposed by the server: the twin that carries the host verdict. */
  twinRow?: ServerRow;
}

interface Composed {
  rows: ServerRow[];
  attempted: number;
  failed: number;
  updates: number;
}

function inventoryKey(entries: readonly InventoryPlugin[], tuiTargets: readonly string[]): string {
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
  return [...new Set([...identities, ...tuiTargets.map((target) => `tui:${target}`)])].sort().join("\n");
}

function serverRowFor(entry: InventoryPlugin): ServerRow | undefined {
  if (entry.source.type === "builtin") return undefined;
  const failure = entry.failed === undefined ? {} : { failed: entry.failed };
  if (entry.source.type === "local") {
    return {
      id: `local:${entry.source.path}`,
      runtime: "server",
      spec: entry.source.path,
      name: entry.id ?? entry.source.path,
      status: "skipped",
      reason: "local path",
      ...failure,
    };
  }
  if (entry.source.type === "sdk") {
    const id = entry.id ?? "sdk";
    return {
      id: `sdk:${id}`,
      runtime: "server",
      spec: id,
      name: id,
      status: "skipped",
      reason: "sdk plugin",
      ...failure,
    };
  }

  const target = entry.source.target;
  const common = {
    id: packageRowId(target),
    runtime: "server" as const,
    spec: target,
    ...(entry.source.version === undefined ? {} : { installedVersion: entry.source.version }),
    ...failure,
  };
  const classification = classifyPluginSpec(target);
  if (classification.kind === "unsupported") {
    return { ...common, name: target, status: "skipped", reason: classification.reason };
  }
  if (classification.kind === "pinned") {
    return {
      ...common,
      name: classification.name,
      status: "pinned",
      pinnedVersion: classification.version,
    };
  }
  return { ...common, name: classification.name, status: "unknown" };
}

/**
 * TUI rows come from the effective local package inventory: cli.json targets
 * plus the TUI halves the server exposes. A cli.json target the TUI cannot
 * load (no installed generation or no ./tui entrypoint) is not part of the
 * effective inventory; a package the server exposes as tui always is.
 */
function tuiRowFor(
  target: string,
  twin: { row: ServerRow; outdated?: boolean } | undefined,
  tui: TuiPackagePort,
): { row: ServerRow; checkable?: Checkable } | undefined {
  const twinRow = twin?.row;
  const common = {
    id: tuiRowId(target),
    runtime: "tui" as const,
    spec: target,
    ...(twinRow === undefined ? {} : { shared: true as const }),
  };
  const classification = classifyPluginSpec(target);
  if (classification.kind === "unsupported") {
    return { row: { ...common, name: target, status: "skipped", reason: classification.reason } };
  }
  if (classification.kind === "pinned") {
    return {
      row: {
        ...common,
        name: classification.name,
        status: "pinned",
        pinnedVersion: classification.version,
      },
    };
  }

  const installedVersion = tui.installedVersion(target) ?? twinRow?.installedVersion;
  if (installedVersion === undefined) return undefined;
  const row: ServerRow = {
    ...common,
    name: classification.name,
    status: "unknown",
    installedVersion,
  };
  // A TUI half the server exposes follows the server's outdated verdict; a
  // cli.json-only package has no host signal, so the registry comparison
  // against the installed generation is the check.
  return {
    row,
    checkable: {
      row,
      name: classification.name,
      ...(twinRow === undefined ? {} : { twinRow }),
      ...(twin?.outdated ? { outdated: true as const } : {}),
    },
  };
}

/**
 * The effective TUI package target set: cli.json targets plus the TUI halves
 * the connected server exposes. Both the cycle and the pre-send verification
 * derive their membership from this one definition.
 */
export function effectiveTuiTargets(entries: readonly InventoryPlugin[], tui: TuiPackagePort): string[] {
  return [
    ...new Set([
      ...tui.cliTargets(),
      ...entries.flatMap((entry) =>
        entry.source.type === "package" && entry.features?.tui === true ? [entry.source.target] : [],
      ),
    ]),
  ];
}

async function composeRows(
  entries: readonly InventoryPlugin[],
  tui: TuiPackagePort,
  options: {
    fetchLatest: FetchLatest;
    timeoutMs: number;
    concurrency: number;
    signal: AbortSignal;
    hostChecked: boolean;
  },
): Promise<Composed & { tuiTargets: string[] }> {
  const rows: ServerRow[] = [];
  const checkable: Checkable[] = [];
  const serverByTarget = new Map<string, { row: ServerRow; tui: boolean; outdated?: boolean }>();

  for (const entry of entries) {
    const row = serverRowFor(entry);
    if (row === undefined) continue;
    rows.push(row);
    if (entry.source.type !== "package") continue;
    serverByTarget.set(entry.source.target, {
      row,
      tui: entry.features?.tui === true,
      ...(entry.source.outdated ? { outdated: true } : {}),
    });
    if (row.status !== "unknown") continue;
    checkable.push({
      row,
      name: (classifyPluginSpec(entry.source.target) as { name: string }).name,
      ...(entry.source.outdated ? { outdated: true } : {}),
    });
  }

  const targets = effectiveTuiTargets(entries, tui);
  const tuiRows: ServerRow[] = [];
  for (const target of targets) {
    const twin = serverByTarget.get(target);
    // A package the server loads without a TUI half never loads in the TUI
    // either, even when cli.json still names it.
    if (twin !== undefined && !twin.tui) continue;
    // Unupdatable specs (local paths, git URLs) still render as skipped rows;
    // installable ones must have an installed generation to be effective.
    if (
      twin === undefined &&
      classifyPluginSpec(target).kind !== "unsupported" &&
      !tui.exposesTui(target)
    ) {
      continue;
    }
    const composed = tuiRowFor(target, twin, tui);
    if (composed === undefined) continue;
    tuiRows.push(composed.row);
    if (composed.checkable !== undefined) checkable.push(composed.checkable);
  }

  const names = [...new Set(checkable.map((item) => item.name))];
  const latestByName = new Map<string, string | undefined>();
  let attempted = 0;
  let failed = 0;
  await mapPool(names, options.concurrency, async (name) => {
    attempted++;
    try {
      const latest = (
        await withTimeout(options.fetchLatest(name, { signal: options.signal }), options.timeoutMs)
      ).version;
      latestByName.set(name, latest);
    } catch {
      failed++;
      latestByName.set(name, undefined);
    }
  });

  for (const item of checkable) {
    const latestVersion = latestByName.get(item.name);
    if (latestVersion !== undefined) item.row.latestVersion = latestVersion;

    if (item.twinRow !== undefined) {
      // The server's verdict is the host authority for the exposed TUI half,
      // but the half's own installed generation decides whether anything is
      // left to apply: a cache that is already ahead stays current.
      const comparison = isUpdateAvailable(item.row.installedVersion, latestVersion);
      if (comparison === false) {
        item.row.status = "current";
      } else if (item.outdated) {
        item.row.status = "update";
      } else if (comparison === true) {
        item.row.status = "unknown";
        item.row.reason = options.hostChecked
          ? "host check did not confirm the update"
          : "host check unavailable";
      } else {
        item.row.status = "unknown";
        item.row.reason =
          latestVersion === undefined ? "registry lookup failed" : "version not parseable";
      }
      continue;
    }
    if (item.outdated) {
      item.row.status = "update";
      continue;
    }
    const comparison = isUpdateAvailable(item.row.installedVersion, latestVersion);
    if (comparison === false) {
      item.row.status = "current";
      continue;
    }
    if (comparison === true) {
      // A cli.json-only TUI row has no host check; its own registry
      // comparison against the installed generation is the evidence.
      if (item.row.runtime === "tui") {
        item.row.status = "update";
      } else {
        item.row.status = "unknown";
        item.row.reason = options.hostChecked
          ? "host check did not confirm the update"
          : "host check unavailable";
      }
      continue;
    }
    item.row.status = "unknown";
    item.row.reason =
      latestVersion === undefined ? "registry lookup failed"
      : item.row.installedVersion === undefined ? "installed version unavailable"
      : "version not parseable";
  }

  rows.push(...tuiRows);
  for (const target of targets) {
    const serverRow = serverByTarget.get(target)?.row;
    const tuiRow = tuiRows.find((row) => row.spec === target);
    if (serverRow === undefined || tuiRow === undefined) continue;
    serverRow.shared = true;
    serverRow.twin = tuiRow.id;
    tuiRow.shared = true;
    tuiRow.twin = serverRow.id;
  }
  return { rows, attempted, failed, updates: countUpdateTargets(rows), tuiTargets: targets };
}

/** A shared Server/TUI pair is one update unit, not two. */
export function countUpdateTargets(rows: readonly ServerRow[]): number {
  return new Set(rows.filter((row) => row.status === "update").map((row) => row.spec)).size;
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
  let lastEnvironment = "";

  async function runCycle(manual: boolean): Promise<boolean> {
    if (disposed) return false;
    setChecking(true);
    try {
      const environment = options.environment();
      const stored = options.state.read();
      const storedHere = stored.version === STORAGE_VERSION && stored.environment === environment;
      if (storedHere && stored.rows.length > 0) {
        setRows(stored.rows);
        lastEnvironment = environment;
      }

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

      const key = inventoryKey(entries, effectiveTuiTargets(entries, options.tui));
      const fresh =
        !manual &&
        storedHere &&
        stored.checkedAt > 0 &&
        now() - stored.checkedAt < CHECK_INTERVAL_MS &&
        stored.inventoryKey === key;
      if (fresh) {
        setRows(stored.rows);
        lastEnvironment = environment;
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

      const composed = await composeRows(checked ?? entries, options.tui, {
        fetchLatest: options.fetchLatest,
        timeoutMs,
        concurrency,
        signal: controller.signal,
        hostChecked,
      });
      if (disposed) return false;

      setRows(composed.rows);
      lastEnvironment = environment;
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
    // A shared Server/TUI pair is one update unit; count targets, not rows.
    updateCount: () => countUpdateTargets(rows()),
    checkedEnvironment: () => lastEnvironment,
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
