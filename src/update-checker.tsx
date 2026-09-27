/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { For } from "solid-js";
import { createNpmRegistryPort } from "./checker.ts";
import { createDurableState } from "./durable-state.ts";
import { connectedLocation, createServerInventoryPort } from "./server-inventory.ts";
import {
  createServerUpdates,
  EMPTY_SERVER_STATE,
  STORAGE_KEY,
  type ServerRow,
  type ServerUpdates,
} from "./server-updates.ts";

const ROUTE = "plugin-updates";
const ID = "supercode.update-checker";

function version(row: ServerRow): string {
  if (row.status === "update") return `${row.installedVersion ?? "unknown"} → ${row.latestVersion ?? "unknown"}`;
  if (row.installedVersion !== undefined && row.latestVersion !== undefined) {
    return `${row.installedVersion} → ${row.latestVersion}`;
  }
  if (row.installedVersion !== undefined) return row.installedVersion;
  if (row.pinnedVersion !== undefined) return row.pinnedVersion;
  return "";
}

function status(row: ServerRow): string {
  switch (row.status) {
    case "update":
      return "update available";
    case "current":
      return "current";
    case "unknown":
      return `unknown: ${row.reason ?? "unverified"}`;
    case "pinned":
      return `pinned at ${row.pinnedVersion ?? "unknown"} · info only`;
    case "skipped":
      return `skipped: ${row.reason ?? "unsupported"}`;
  }
}

function line(row: ServerRow): string {
  const parts = [row.spec, version(row), status(row)].filter((part) => part.length > 0);
  return `${parts.join("  ·  ")}${row.failed ? `  ·  failed: ${row.failed}` : ""}`;
}

function statusLine(model: ServerUpdates): string {
  if (model.checking()) return "Checking for updates…";
  if (model.error()) return `Check failed: ${model.error()}`;
  if (model.checkFailed()) return "Host check unavailable · update availability unverified.";
  if (model.rows().length === 0) return "No server plugins configured.";
  return model.freshness() === "fresh" ? "Checked for updates." : "Showing last check.";
}

function Screen(props: { context: Plugin.Context; model: ServerUpdates; back: () => void }) {
  const { context, model } = props;
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { bind: "escape", title: "Back", run: props.back },
      { bind: "r", title: "Refresh", run: () => void model.refresh() },
    ],
  }));

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1}>
      <text fg={context.theme.text.base}><b>Plugin Updates · Server</b></text>
      <text fg={context.theme.text.muted}>{statusLine(model)}  ·  R refresh · Esc back</text>
      <For each={model.rows()}>{(row) => <text fg={context.theme.text.base}>{line(row)}</text>}</For>
    </box>
  );
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const model = createServerUpdates({
      inventory: createServerInventoryPort(context),
      state: createDurableState(context.storage, STORAGE_KEY, EMPTY_SERVER_STATE),
      environment: () => connectedLocation(context).directory,
      fetchLatest: createNpmRegistryPort(),
      toast: (message) => context.ui.toast.show({ message }),
    });
    let previous: ReturnType<typeof context.ui.router.current> = { type: "home" };
    const unregister = context.ui.router.register({
      name: ROUTE,
      render: () => <Screen context={context} model={model} back={() => context.ui.router.navigate(previous)} />,
    });
    const unregisterSlot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "supercode.plugin-updates.open",
            title: "Plugin updates",
            description: "Show server plugin versions and updates",
            palette: true,
            slash: { name: "plugin-updates" },
            run: () => {
              const current = context.ui.router.current();
              if (current.type === "plugin" && current.name === ROUTE && current.id === ID) return;
              previous = { ...current };
              context.ui.router.navigate({ type: "plugin", name: ROUTE });
            },
          }],
        }));
        return null;
      },
    });
    // The automatic cycle runs at setup without blocking the first render.
    void model.start();
    return () => {
      model.dispose();
      unregisterSlot();
      unregister();
    };
  },
});
