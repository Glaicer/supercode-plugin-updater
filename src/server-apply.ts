import { createSignal } from "solid-js";
import { errorMessage } from "./checker.ts";
import type { InventoryPlugin } from "./server-inventory.ts";
import { packageRowId, type ServerRow } from "./server-updates.ts";

export type ApplyPhase = "updating" | "updated" | "failed" | "missing";

export interface ApplyResult {
  phase: ApplyPhase;
  /** Failure detail for `failed`, or the reason a target was not updated. */
  message?: string;
  /**
   * The update call succeeded but the fresh inventory does not back it: the
   * re-read failed or the target is no longer listed, so neither the
   * installed version nor activation is confirmed.
   */
  unverified?: boolean;
}

export interface AppliedTarget {
  target: string;
  previousVersion?: string;
}

export interface SettleResult {
  /** Whether a fresh inventory was actually read. */
  read: boolean;
  /** Updated targets the fresh inventory no longer lists. */
  absent: readonly string[];
}

export interface ServerApplyPorts {
  /** Current server inventory, read again before anything is sent. */
  readonly list: (signal?: AbortSignal) => Promise<readonly InventoryPlugin[]>;
  /** Updates exactly one target through the connected server. */
  readonly update: (target: string, signal?: AbortSignal) => Promise<void>;
  /**
   * Post-operation re-read. The server re-activates updated plugins
   * asynchronously, so one read may still report the old generation: the
   * implementer polls until every updated target reports a version different
   * from before, then reports whether the fresh inventory was read and which
   * targets it no longer lists.
   */
  readonly settle: (updated: readonly AppliedTarget[]) => Promise<SettleResult>;
}

export interface ServerApply {
  selected(): ReadonlySet<string>;
  toggle(row: ServerRow): void;
  selectAll(rows: readonly ServerRow[]): void;
  clearSelection(): void;
  /** Rows that are both marked and still updatable right now. */
  selectedRows(rows: readonly ServerRow[]): ServerRow[];
  result(id: string): ApplyResult | undefined;
  results(): ReadonlyMap<string, ApplyResult>;
  running(): boolean;
  /**
   * Sends one update per row after re-verifying them against the current
   * inventory. A repeat call while an operation runs joins it instead of
   * re-sending anything.
   */
  execute(rows: readonly ServerRow[]): Promise<void>;
  dispose(): void;
}

/**
 * A row can receive an update right now: the host confirmed one is available
 * and no operation is running for it.
 */
function isUpdatable(row: ServerRow, results: ReadonlyMap<string, ApplyResult>): boolean {
  return row.status === "update" && results.get(row.id)?.phase !== "updating";
}

export function createServerApply(ports: ServerApplyPorts): ServerApply {
  // Selection and outcomes render inside Solid computations, so every
  // mutation replaces the snapshot instead of editing it in place.
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [results, setResults] = createSignal<ReadonlyMap<string, ApplyResult>>(new Map());
  const [running, setRunning] = createSignal(false);
  const controller = new AbortController();
  let disposed = false;
  let operation: Promise<void> | undefined;

  function record(id: string, result: ApplyResult): void {
    setResults((previous) => {
      const next = new Map(previous);
      next.set(id, result);
      return next;
    });
  }

  function clearSelection(): void {
    setSelected(new Set<string>());
  }

  async function execute(rows: readonly ServerRow[]): Promise<void> {
    if (operation !== undefined) return operation;
    setRunning(true);
    operation = (async () => {
      try {
        const targets = rows.map((row) => row.spec);
        const previous = new Map(rows.map((row) => [row.spec, row.installedVersion]));
        let entries: readonly InventoryPlugin[];
        try {
          entries = await ports.list(controller.signal);
        } catch {
          // Without a current inventory nothing can be verified: send nothing.
          if (!disposed) {
            for (const target of targets) {
              record(packageRowId(target), { phase: "missing", message: "inventory unavailable" });
            }
          }
          return;
        }
        if (disposed) return;
        const present = new Set(
          entries.flatMap((entry) => (entry.source.type === "package" ? [entry.source.target] : [])),
        );
        const sendable: string[] = [];
        for (const target of targets) {
          if (!present.has(target)) {
            record(packageRowId(target), { phase: "missing" });
            continue;
          }
          sendable.push(target);
        }
        const applied: AppliedTarget[] = [];
        for (const target of sendable) {
          if (disposed) return;
          record(packageRowId(target), { phase: "updating" });
          try {
            await ports.update(target, controller.signal);
            applied.push({ target, previousVersion: previous.get(target) });
            record(packageRowId(target), { phase: "updated" });
          } catch (reason) {
            record(packageRowId(target), { phase: "failed", message: errorMessage(reason) });
          }
        }
        if (disposed || applied.length === 0) return;
        const outcome = await ports.settle(applied);
        for (const { target } of applied) {
          const result = results().get(packageRowId(target));
          if (result?.phase !== "updated") continue;
          if (!outcome.read || outcome.absent.includes(target)) {
            record(packageRowId(target), { ...result, unverified: true });
          }
        }
      } finally {
        operation = undefined;
        setRunning(false);
        clearSelection();
      }
    })();
    return operation;
  }

  return {
    selected,
    toggle(row) {
      if (!isUpdatable(row, results())) return;
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    },
    selectAll(rows) {
      setSelected((previous) => {
        const next = new Set(previous);
        for (const row of rows) {
          if (isUpdatable(row, results())) next.add(row.id);
        }
        return next;
      });
    },
    clearSelection,
    selectedRows(rows) {
      const marked = selected();
      return rows.filter((row) => marked.has(row.id) && isUpdatable(row, results()));
    },
    result: (id) => results().get(id),
    results,
    running,
    execute,
    dispose() {
      disposed = true;
      controller.abort();
    },
  };
}
