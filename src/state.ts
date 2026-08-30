/**
 * state — the plugin's keyspace in `api.kv` under the `plugin-updates.*`
 * prefix. `api.kv` is host-global, so this state is per machine, never per
 * project (US 24). The runtime kv has no `delete`: erasure is a written
 * `null` (US 24) — reads below treat `null` as absent. `plugin-updates.pending`
 * arrives with ticket 04 and will be erased the same way.
 */
import type { TuiKV } from "@opencode-ai/plugin/tui";
import type { CheckResult } from "./update-model.ts";

const UPDATE_STATE_PREFIX = "plugin-updates.";

const LAST_CHECK_KEY = `${UPDATE_STATE_PREFIX}lastCheck`;
const AVAILABLE_KEY = `${UPDATE_STATE_PREFIX}available`;

export interface UpdateState {
  /** Epoch ms of the last successful cycle; `undefined` when absent or null-erased. */
  getLastCheck(): number | undefined;
  setLastCheck(at: number): void;
  /** Snapshot of the last successful cycle; `undefined` when absent. */
  getAvailable(): CheckResult | undefined;
  setAvailable(snapshot: CheckResult): void;
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
  };
}
