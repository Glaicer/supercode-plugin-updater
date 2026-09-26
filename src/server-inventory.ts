import { createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";

type Inventory = Awaited<ReturnType<Plugin.Context["client"]["plugin"]["list"]>>["data"];

export function createServerInventory(context: Plugin.Context) {
  const [plugins, setPlugins] = createSignal<Inventory>([]);
  const [status, setStatus] = createSignal<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = createSignal("");
  let generation = 0;

  return {
    plugins,
    status,
    error,
    async load() {
      const current = ++generation;
      setStatus("loading");
      try {
        const location = context.location ?? context.data.location.default();
        const result = await context.client.plugin.list({ location });
        if (current !== generation) return;
        const installed = result.data.filter((plugin) => plugin.source.type !== "builtin");
        setPlugins(installed);
        setStatus(installed.length ? "ready" : "empty");
      } catch (reason) {
        if (current !== generation) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("error");
      }
    },
    dispose() {
      generation++;
    },
  };
}
