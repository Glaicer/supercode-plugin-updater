/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { For, Show } from "solid-js";
import { createServerInventory } from "./server-inventory.ts";

const ROUTE = "plugin-updates";
const ID = "supercode.update-checker";

function Screen(props: {
  context: Plugin.Context;
  model: ReturnType<typeof createServerInventory>;
  back: () => void;
}) {
  const { context, model } = props;
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{ bind: "escape", title: "Back", run: props.back }],
  }));

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1}>
      <text fg={context.theme.text.base}><b>Plugin Updates · Server</b></text>
      <text fg={context.theme.text.muted}>Esc to return</text>
      <Show when={model.status() === "loading"}><text fg={context.theme.text.muted}>Loading server plugins…</text></Show>
      <Show when={model.status() === "error"}><text fg={context.theme.text.base}>Server inventory unavailable: {model.error()}</text></Show>
      <Show when={model.status() === "empty"}><text fg={context.theme.text.muted}>No server plugins configured.</text></Show>
      <Show when={model.status() === "ready"}>
        <For each={model.plugins()}>{(plugin) => (
          <text fg={context.theme.text.base}>
            {plugin.source.type === "package" ? plugin.source.target : plugin.id ?? plugin.source.type}
            {plugin.source.type === "package" && plugin.source.version ? ` · ${plugin.source.version}` : ""}
            {plugin.state.status === "failed" ? ` · failed: ${plugin.state.error}` : ""}
          </text>
        )}</For>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const model = createServerInventory(context);
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
            description: "Show server plugins",
            palette: true,
            slash: { name: "plugin-updates" },
            run: () => {
              const current = context.ui.router.current();
              void model.load();
              if (current.type === "plugin" && current.name === ROUTE && current.id === ID) return;
              previous = { ...current };
              context.ui.router.navigate({ type: "plugin", name: ROUTE });
            },
          }],
        }));
        return null;
      },
    });
    return () => {
      model.dispose();
      unregisterSlot();
      unregister();
    };
  },
});
