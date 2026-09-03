// The host-global kv has no delete operation, so null represents erased state.
import type { TuiKV } from "@opencode-ai/plugin/tui";
import type { CheckResult, PendingInvalidationEntry } from "./update-model.ts";

const UPDATE_STATE_PREFIX = "plugin-updates.";

const LAST_CHECK_KEY = `${UPDATE_STATE_PREFIX}lastCheck`;
const AVAILABLE_KEY = `${UPDATE_STATE_PREFIX}available`;
const PENDING_KEY = `${UPDATE_STATE_PREFIX}pending`;
const CHECKED_PLUGIN_SPECS_KEY = `${UPDATE_STATE_PREFIX}checkedPluginSpecs`;

export interface UpdateState {
  getLastCheck(): number | undefined;
  setLastCheck(at: number): void;
  getAvailable(): CheckResult | undefined;
  setAvailable(snapshot: CheckResult): void;
  getCheckedPluginSpecs(): string[] | undefined;
  setCheckedPluginSpecs(specs: readonly string[]): void;
  getPending(): PendingInvalidationEntry[] | undefined;
  setPending(entries: readonly PendingInvalidationEntry[] | null): void;
}

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
    getCheckedPluginSpecs: () => {
      const value: unknown = kv.get(CHECKED_PLUGIN_SPECS_KEY);
      return Array.isArray(value) && value.every((spec) => typeof spec === "string")
        ? value
        : undefined;
    },
    setCheckedPluginSpecs: (specs) => {
      kv.set(CHECKED_PLUGIN_SPECS_KEY, [...specs]);
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
