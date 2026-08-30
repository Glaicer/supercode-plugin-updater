/**
 * state — the plugin's keyspace in `api.kv` under the `plugin-updates.*`
 * prefix. `api.kv` is host-global, so this state is per machine, never per
 * project (US 24). The runtime kv has no `delete`: erasure is a written
 * `null` (US 24) — reads below treat `null` as absent.
 */
import type { TuiKV } from "@opencode-ai/plugin/tui";
import type { CheckResult, PendingInvalidationEntry } from "./update-model.ts";

const UPDATE_STATE_PREFIX = "plugin-updates.";

const LAST_CHECK_KEY = `${UPDATE_STATE_PREFIX}lastCheck`;
const AVAILABLE_KEY = `${UPDATE_STATE_PREFIX}available`;
const PENDING_KEY = `${UPDATE_STATE_PREFIX}pending`;

export interface UpdateState {
  /** Epoch ms of the last successful cycle; `undefined` when absent or null-erased. */
  getLastCheck(): number | undefined;
  setLastCheck(at: number): void;
  /** Snapshot of the last successful cycle; `undefined` when absent. */
  getAvailable(): CheckResult | undefined;
  setAvailable(snapshot: CheckResult): void;
  /**
   * Pending Invalidation marker: the confirmed `{kind, spec}` list with
   * corrupt entries dropped; `undefined` when absent, null-erased, empty,
   * or holding nothing valid.
   */
  getPending(): PendingInvalidationEntry[] | undefined;
  /** Writes the marker; `null` erases it (no kv delete). */
  setPending(entries: readonly PendingInvalidationEntry[] | null): void;
}

/**
 * Runtime shape check for one marker entry (the kv value is untyped): a
 * valid kind and a non-empty spec. Shared with the model's confirm filter.
 */
export function isPendingEntry(value: unknown): value is PendingInvalidationEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { kind?: unknown; spec?: unknown };
  return (
    (entry.kind === "plugin" || entry.kind === "tool") &&
    typeof entry.spec === "string" &&
    entry.spec.length > 0
  );
}

export function createUpdateState(kv: TuiKV): UpdateState {
  function read<Value>(key: string): Value | undefined {
    const value: unknown = kv.get(key);
    return value === null || value === undefined ? undefined : (value as Value);
  }
  return {
    getLastCheck: () => read<number>(LAST_CHECK_KEY),
    setLastCheck: (at) => {
      kv.set(LAST_CHECK_KEY, at);
    },
    getAvailable: () => read<CheckResult>(AVAILABLE_KEY),
    setAvailable: (snapshot) => {
      kv.set(AVAILABLE_KEY, snapshot);
    },
    getPending: () => {
      const value: unknown = kv.get(PENDING_KEY);
      if (!Array.isArray(value)) return undefined;
      const entries = value.filter(isPendingEntry);
      return entries.length > 0 ? entries : undefined;
    },
    setPending: (entries) => {
      kv.set(PENDING_KEY, entries);
    },
  };
}
