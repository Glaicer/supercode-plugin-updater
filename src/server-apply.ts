import { createSignal } from "solid-js";
import { errorMessage } from "./checker.ts";
import type { InventoryPlugin } from "./server-inventory.ts";
import { packageRowId, tuiRowId, type Runtime, type ServerRow } from "./server-updates.ts";
import type { CliUpdateResult } from "./tui-packages.ts";

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
  /** The operation reported success but the fresh inventory shows no change. */
  unchanged?: boolean;
}

export interface AppliedRuntime {
  runtime: Runtime;
  previousVersion?: string;
  /** The CLI reported this runtime as updated; unclaimed shared halves rely on the re-read. */
  claimed?: boolean;
}

export interface AppliedTarget {
  target: string;
  runtimes: AppliedRuntime[];
}

export interface SettleResult {
  /** Whether a fresh inventory was actually read. */
  read: boolean;
  /** `runtime:target` keys the fresh inventory no longer lists. */
  absent: readonly string[];
  /** `runtime:target` keys whose installed version moved. */
  confirmed: readonly string[];
  /** `runtime:target` keys whose fresh row carries no installed version. */
  unversioned: readonly string[];
}

export function settleKey(runtime: Runtime, target: string): string {
  return `${runtime}:${target}`;
}

export function rowIdFor(runtime: Runtime, target: string): string {
  return runtime === "server" ? packageRowId(target) : tuiRowId(target);
}

export interface ServerApplyPorts {
  /** Current server inventory, read again before anything is sent. */
  readonly list: (signal?: AbortSignal) => Promise<readonly InventoryPlugin[]>;
  /**
   * Current effective TUI package targets for the just-read server inventory,
   * verified again before anything is sent.
   */
  readonly tuiTargets: (entries: readonly InventoryPlugin[], signal?: AbortSignal) => Promise<readonly string[]>;
  /** Updates exactly one server target through the connected server. */
  readonly update: (target: string, signal?: AbortSignal) => Promise<void>;
  /**
   * The standard CLI for exactly one target; the TUI runtime and the shared
   * Server+TUI group are applied through it, never through a second server
   * API call for the same target.
   */
  readonly runCli: (target: string, cwd: string, signal?: AbortSignal) => Promise<CliUpdateResult>;
  /** The connected location directory; the CLI subprocess binds to it as cwd. */
  readonly location: () => string;
  /**
   * The environment the rows on screen were checked against. A send is only
   * allowed while the live connection still points at it.
   */
  readonly checkedEnvironment: () => string;
  /**
   * Post-operation re-read. The server re-activates updated plugins
   * asynchronously, so one read may still report the old generation: the
   * implementer polls until every applied runtime reports a version different
   * from before, then reports whether the fresh inventory was read, which
   * keys it no longer lists, and which keys moved.
   */
  readonly settle: (updated: readonly AppliedTarget[]) => Promise<SettleResult>;
}

export interface ServerApply {
  selected(): ReadonlySet<string>;
  toggle(row: ServerRow): void;
  selectAll(rows: readonly ServerRow[]): void;
  clearSelection(): void;
  /**
   * Rows to send for the current marks: every marked row whose group still
   * has an updatable member, including a shared twin that is currently
   * up-to-date.
   */
  selectedRows(rows: readonly ServerRow[]): ServerRow[];
  result(id: string): ApplyResult | undefined;
  results(): ReadonlyMap<string, ApplyResult>;
  running(): boolean;
  /**
   * Sends one operation per target after re-verifying the selection against
   * both inventories: server-only targets through the server API, TUI-only
   * targets and shared groups through one CLI call each. A repeat call while
   * an operation runs joins it instead of re-sending anything.
   */
  execute(rows: readonly ServerRow[]): Promise<void>;
  dispose(): void;
}

/**
 * A row can receive an update right now: the host confirmed one is available
 * and no operation is running for it. Managed tool rows are informational and
 * can never receive an update.
 */
function isUpdatable(row: ServerRow, results: ReadonlyMap<string, ApplyResult>): boolean {
  return (
    row.status === "update" && row.runtime !== "tool" && results.get(row.id)?.phase !== "updating"
  );
}

interface CliVerdict {
  claimed: ReadonlySet<Runtime>;
  failed: ReadonlyMap<Runtime, string>;
  failedRun: boolean;
}

const RUNTIME_LABELS: Record<Runtime, string> = { server: "Server", tui: "TUI" };

/**
 * The CLI prints one line per applied runtime and sends failures to stderr.
 * Lines name the plugin id rather than the target, so verdicts are counted
 * per runtime instead of matched by name.
 */
function parseCliResult(result: CliUpdateResult): CliVerdict {
  const claimed = new Set<Runtime>();
  const failed = new Map<Runtime, string>();
  for (const runtime of ["server", "tui"] as const) {
    const label = RUNTIME_LABELS[runtime];
    if (new RegExp(`Updated ${label} plugin`).test(result.stdout)) claimed.add(runtime);
    const line = result.stderr
      .split("\n")
      .find((candidate) => new RegExp(`Failed to (update|check) ${label} plugin`).test(candidate));
    if (line !== undefined) {
      const text = line.trim();
      failed.set(runtime, text.length > 0 ? text.slice(0, 400) : "update failed");
    }
  }
  return {
    claimed,
    failed,
    failedRun: claimed.size === 0 && failed.size === 0 && result.code !== 0,
  };
}

/** The two rows of one target as they are currently sendable. */
interface UpdateUnit {
  server?: ServerRow;
  tui?: ServerRow;
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

  function markGroup(row: ServerRow, mark: boolean): void {
    const ids = row.twin === undefined ? [row.id] : [row.id, row.twin];
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (mark) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function runCliUnit(
    target: string,
    unit: UpdateUnit,
    previous: ReadonlyMap<string, string | undefined>,
    applied: AppliedTarget[],
  ): Promise<void> {
    const members = (["server", "tui"] as const).filter((runtime) => unit[runtime] !== undefined);
    for (const runtime of members) record(rowIdFor(runtime, target), { phase: "updating" });
    let verdict: CliVerdict;
    try {
      verdict = parseCliResult(await ports.runCli(target, ports.location(), controller.signal));
    } catch (reason) {
      if (disposed) return;
      const message = errorMessage(reason);
      for (const runtime of members) record(rowIdFor(runtime, target), { phase: "failed", message });
      return;
    }
    if (disposed) return;
    const runtimes: AppliedRuntime[] = [];
    const anyClaim = verdict.claimed.size > 0;
    for (const runtime of members) {
      const id = rowIdFor(runtime, target);
      const failure = verdict.failed.get(runtime);
      if (failure !== undefined) {
        record(id, { phase: "failed", message: failure });
        continue;
      }
      if (verdict.failedRun) {
        record(id, { phase: "failed", message: "cli update failed" });
        continue;
      }
      const claimed = verdict.claimed.has(runtime);
      if (claimed || (unit.server !== undefined && unit.tui !== undefined && anyClaim)) {
        // A shared half moves with the same generation even when the CLI
        // only names the other runtime; the re-read decides.
        record(id, { phase: "updated" });
        runtimes.push({
          runtime,
          previousVersion: previous.get(id),
          ...(claimed ? { claimed: true } : {}),
        });
        continue;
      }
      record(id, { phase: "missing", message: "the host did not confirm an update" });
    }
    if (runtimes.length > 0) applied.push({ target, runtimes });
  }

  async function execute(rows: readonly ServerRow[]): Promise<void> {
    if (operation !== undefined) return operation;
    setRunning(true);
    operation = (async () => {
      try {
        const previous = new Map(rows.map((row) => [row.id, row.installedVersion]));
        // The rows were checked against a specific server/location; a send
        // may only leave for the same one, otherwise the outcome would
        // describe a connection the user never confirmed.
        const checkedEnvironment = ports.checkedEnvironment();
        if (checkedEnvironment !== "" && ports.location() !== checkedEnvironment) {
          for (const row of rows) {
            record(row.id, { phase: "missing", message: "location changed since the check" });
          }
          return;
        }
        let entries: readonly InventoryPlugin[];
        try {
          entries = await ports.list(controller.signal);
        } catch {
          // Without a current inventory nothing can be verified: send nothing.
          if (!disposed) {
            for (const row of rows) {
              record(row.id, { phase: "missing", message: "inventory unavailable" });
            }
          }
          return;
        }
        if (disposed) return;
        const serverTargets = new Set(
          entries.flatMap((entry) => (entry.source.type === "package" ? [entry.source.target] : [])),
        );
        let tuiTargets: ReadonlySet<string>;
        try {
          tuiTargets = new Set(await ports.tuiTargets(entries, controller.signal));
        } catch {
          tuiTargets = new Set();
        }
        if (disposed) return;

        // Membership must still match what the rows were composed with; a
        // target whose runtimes changed is blocked as a whole group.
        const changed = new Set<string>();
        for (const row of rows) {
          const serverPresent = serverTargets.has(row.spec);
          const tuiPresent = tuiTargets.has(row.spec);
          const mismatch =
            (row.runtime === "server" && !serverPresent) ||
            (row.runtime === "tui" && !tuiPresent) ||
            (row.shared === true && !(serverPresent && tuiPresent)) ||
            (row.shared !== true && serverPresent && tuiPresent);
          if (mismatch) {
            record(row.id, { phase: "missing", message: "inventory changed" });
            changed.add(row.spec);
          }
        }

        const units = new Map<string, UpdateUnit>();
        for (const row of rows) {
          if (changed.has(row.spec)) continue;
          const unit = units.get(row.spec) ?? {};
          if (row.runtime === "server") unit.server = row;
          else unit.tui = row;
          units.set(row.spec, unit);
        }

        const applied: AppliedTarget[] = [];
        for (const [target, unit] of units) {
          if (disposed) return;
          if (unit.server !== undefined && unit.tui !== undefined) {
            // One CLI call covers both runtimes; never a second server API
            // update for the same target.
            await runCliUnit(target, unit, previous, applied);
            continue;
          }
          if (unit.tui !== undefined) {
            await runCliUnit(target, { tui: unit.tui }, previous, applied);
            continue;
          }
          const row = unit.server;
          if (row === undefined) continue;
          record(row.id, { phase: "updating" });
          try {
            await ports.update(target, controller.signal);
            applied.push({
              target,
              runtimes: [{ runtime: "server", previousVersion: previous.get(row.id), claimed: true }],
            });
            record(row.id, { phase: "updated" });
          } catch (reason) {
            if (disposed) return;
            record(row.id, { phase: "failed", message: errorMessage(reason) });
          }
        }
        if (disposed || applied.length === 0) return;
        const outcome = await ports.settle(applied);
        for (const { target, runtimes } of applied) {
          for (const { runtime, claimed } of runtimes) {
            const key = settleKey(runtime, target);
            const id = rowIdFor(runtime, target);
            const result = results().get(id);
            if (result?.phase !== "updated") continue;
            if (!outcome.read || outcome.absent.includes(key) || outcome.unversioned.includes(key)) {
              // Without an observed version the claim stays a claim.
              record(id, { ...result, unverified: true });
            } else if (!outcome.confirmed.includes(key)) {
              record(
                id,
                claimed === true
                  ? { ...result, unchanged: true }
                  : { phase: "missing", message: "the host did not confirm an update" },
              );
            }
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
      const marked = selected().has(row.id);
      markGroup(row, !marked);
    },
    selectAll(rows) {
      setSelected((previous) => {
        const next = new Set(previous);
        for (const row of rows) {
          if (!isUpdatable(row, results())) continue;
          next.add(row.id);
          if (row.twin !== undefined) next.add(row.twin);
        }
        return next;
      });
    },
    clearSelection,
    selectedRows(rows) {
      const marked = selected();
      const updatable = new Set(rows.filter((row) => isUpdatable(row, results())).map((row) => row.id));
      return rows.filter(
        (row) => marked.has(row.id) && (updatable.has(row.id) || (row.twin !== undefined && updatable.has(row.twin))),
      );
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
