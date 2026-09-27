import type { Plugin } from "@opencode/plugin/tui";

export interface DurableState<Value extends object> {
  read(): Value;
  write(next: Value): Promise<void>;
}

/**
 * The host store keeps the whole value as one JSON file. Reads return the live
 * shape and writes replace every field, so a new schema version never merges
 * with stale fields from an older one.
 */
export function createDurableState<Value extends object>(
  storage: Plugin.Context["storage"],
  key: string,
  initial: Value,
): DurableState<Value> {
  const [state, update] = storage.store<Value>(key, { initial });
  return {
    read: () => ({ ...state }),
    write: (next) =>
      update((draft) => {
        for (const name of Object.keys(draft)) delete (draft as Record<string, unknown>)[name];
        Object.assign(draft, next);
      }),
  };
}
