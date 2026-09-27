import type { Plugin } from "@opencode/plugin/tui";

type RawPluginInfo = Awaited<ReturnType<Plugin.Context["client"]["plugin"]["list"]>>["data"][number];

export type InventorySource =
  | { type: "package"; target: string; version?: string; outdated: boolean }
  | { type: "local"; path: string }
  | { type: "sdk" }
  | { type: "builtin" };

/**
 * The server inventory narrowed to the fields the screen acts on. Versions and
 * update availability come from the connected server, never from local
 * config or cache.
 */
export interface InventoryPlugin {
  id?: string;
  source: InventorySource;
  failed?: string;
}

export interface InventoryPort {
  list(signal?: AbortSignal): Promise<readonly InventoryPlugin[]>;
  check(signal?: AbortSignal): Promise<readonly InventoryPlugin[]>;
}

function toInventoryPlugin(info: RawPluginInfo): InventoryPlugin {
  const source = info.source;
  const failed = info.state.status === "failed" ? info.state.error : undefined;
  switch (source.type) {
    case "package":
      return {
        id: info.id,
        source: {
          type: "package",
          target: source.target,
          version: source.version,
          outdated: source.outdated === true,
        },
        failed,
      };
    case "local":
      return { id: info.id, source: { type: "local", path: source.path }, failed };
    case "sdk":
      return { id: info.id, source: { type: "sdk" }, failed };
    case "builtin":
      return { source: { type: "builtin" }, failed };
  }
}

export function connectedLocation(context: Plugin.Context): { directory: string } {
  return context.location ?? context.data.location.default();
}

export function createServerInventoryPort(context: Plugin.Context): InventoryPort {
  const location = () => connectedLocation(context);
  return {
    async list(signal) {
      const result = await context.client.plugin.list({ location: location() }, { signal });
      return result.data.map(toInventoryPlugin);
    },
    async check(signal) {
      const result = await context.client.plugin.check({ location: location() }, { signal });
      return result.data.map(toInventoryPlugin);
    },
  };
}
