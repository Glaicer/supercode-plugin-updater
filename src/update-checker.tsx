/**
 * supercode.update-checker — TUI plugin shell for the Update Checker
 * (feature 041, ticket 05). This file is the View plus registration only:
 * every bit of check logic lives in ./update-model.ts (the tested seam).
 *
 * Registration surface (probe-verified on runtime 1.18.21, see
 * .scratch/041-update-checker/probe/RESULTS.md):
 * - `api.route.register` mounts the read-only `/plugin-updates` screen;
 *   `register` returns an unsubscribe, wired to `lifecycle.onDispose` so a
 *   plugin reload cannot leak a stale route.
 * - `api.keymap.registerLayer` adds the command-palette entry; `slashName`
 *   makes it reachable as `/plugin-updates`. The command only navigates —
 *   the host's own diff-viewer uses the same registerLayer + navigate shape.
 * - The screen binds Escape for as long as it is mounted: the layer is
 *   registered in `onMount` and unregistered in `onCleanup`, so the binding
 *   never fires outside the route. Closing returns to the route the palette
 *   was opened from (home when there is none).
 *
 * On open the screen renders the stored `available` snapshot from kv
 * immediately — no network wait (US 29). While the startup check cycle is
 * running, an indicator line shows above the list (US 28); when the cycle
 * settles, the snapshot is re-read and the list updates reactively.
 *
 * Read-only by design: three groups with headers (Plugins / Managed tools /
 * Skipped), no checkboxes and no actions — interactivity is ticket 06.
 */
/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
  createUpdateModel,
  type CheckResult,
  type SkippedSpec,
  type UpdateCandidate,
} from "./update-model.ts";

const ROUTE_NAME = "plugin-updates";

/** What the palette command stashes into the route params for Esc (US 14). */
interface ReturnRouteParams {
  returnRoute?: { name: string; params?: Record<string, unknown> };
}

/**
 * Where Esc should land: the route the screen was opened from, or home.
 * The palette command stashes `route.current` into the route params (same
 * pattern as the host's diff viewer with its `returnRoute`).
 */
function goBack(api: TuiPluginApi): void {
  const back = (api.route.current as { params?: ReturnRouteParams }).params?.returnRoute;
  api.route.navigate(back?.name ?? "home", back?.params);
}

/** One read-only candidate line: version pair, pinned badge or unknown reason. */
function CandidateRow(props: { api: TuiPluginApi; candidate: UpdateCandidate }) {
  const theme = () => props.api.theme.current;
  const c = () => props.candidate;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
      <text fg={theme().text}>{c().spec}</text>
      <Show
        when={c().status === "pinned"}
        fallback={
          <Show
            when={c().status === "checked"}
            fallback={
              <text fg={theme().warning}>
                {`unknown — ${c().reason ?? "no data"}`}
              </text>
            }
          >
            <box flexDirection="row" gap={1}>
              <Show when={c().updateAvailable === true}>
                <text fg={theme().success}>{`${c().installedVersion} →`}</text>
                <text fg={theme().text} attributes={TextAttributes.BOLD}>
                  {c().latestVersion}
                </text>
              </Show>
              <Show when={c().updateAvailable === false}>
                <text fg={theme().textMuted}>{`${c().installedVersion ?? "?"} up to date`}</text>
              </Show>
            </box>
          </Show>
        }
      >
        <text fg={theme().textMuted}>{`pinned at ${c().pinnedVersion ?? "?"}`}</text>
      </Show>
    </box>
  );
}

/** One skipped-spec line: the spec and why it cannot be checked. */
function SkippedRow(props: { api: TuiPluginApi; skipped: SkippedSpec }) {
  const theme = () => props.api.theme.current;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
      <text fg={theme().textMuted}>{props.skipped.spec}</text>
      <text fg={theme().textMuted}>{props.skipped.reason}</text>
    </box>
  );
}

/** One group header (Plugins / Managed tools / Skipped) plus its rows. */
function Group(props: { api: TuiPluginApi; title: string; children: JSX.Element }) {
  const theme = () => props.api.theme.current;
  return (
    <>
      <text fg={theme().primary} attributes={TextAttributes.BOLD} paddingTop={1}>
        {props.title}
      </text>
      {props.children}
    </>
  );
}

function UpdatesScreen(props: {
  api: TuiPluginApi;
  snapshot: () => CheckResult | undefined;
  checking: () => boolean;
}) {
  const theme = () => props.api.theme.current;
  const plugins = () => (props.snapshot()?.candidates ?? []).filter((c) => c.kind === "plugin");
  const tools = () => (props.snapshot()?.candidates ?? []).filter((c) => c.kind === "tool");
  const skipped = () => props.snapshot()?.skipped ?? [];
  const nothingStored = () => !props.snapshot() && !props.checking();

  // Escape is bound only while this screen is mounted: registered on mount,
  // unregistered on unmount, so the binding never leaks to other routes.
  onMount(() => {
    const cleanup: unknown = props.api.keymap.registerLayer({
      commands: [
        {
          name: "plugin-updates.close",
          desc: "Close the plugin updates screen",
          run: () => goBack(props.api),
        },
      ],
      bindings: [{ key: "escape", cmd: "plugin-updates.close", desc: "Close", group: "Plugin Updates" }],
    });
    onCleanup(() => {
      if (typeof cleanup === "function") (cleanup as () => void)();
    });
  });

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text fg={theme().primary} attributes={TextAttributes.BOLD}>
        Plugin Updates
      </text>
      <text fg={theme().textMuted}>{`esc close`}</text>
      <Show when={props.checking()}>
        <text fg={theme().info}>Checking for updates…</text>
      </Show>
      <Show when={nothingStored()}>
        <text fg={theme().textMuted}>
          No update data yet — the check runs once a day on startup and stores its result here.
        </text>
      </Show>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <Group api={props.api} title="Plugins">
          <For each={plugins()}>{(candidate) => <CandidateRow api={props.api} candidate={candidate} />}</For>
        </Group>
        <Group api={props.api} title="Managed tools">
          <For each={tools()}>{(candidate) => <CandidateRow api={props.api} candidate={candidate} />}</For>
        </Group>
        <Group api={props.api} title="Skipped">
          <For each={skipped()}>{(row) => <SkippedRow api={props.api} skipped={row} />}</For>
        </Group>
      </box>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const model = createUpdateModel(api);
  const [snapshot, setSnapshot] = createSignal<CheckResult | undefined>(model.getSnapshot());
  const [checking, setChecking] = createSignal(false);

  // Start-time decision (US 1, 3): asynchronous, never blocks init. The
  // model yields before touching state or network; the indicator only
  // tracks the cycle so an open screen shows progress (US 28) and picks up
  // the fresh snapshot when the cycle settles.
  setChecking(true);
  void model
    .start()
    .catch(() => {
      // A failed cycle keeps the previous state; the next start retries.
    })
    .finally(() => {
      setChecking(false);
      setSnapshot(model.getSnapshot());
    });

  const unregisterRoute = api.route.register([
    {
      name: ROUTE_NAME,
      render: () => <UpdatesScreen api={api} snapshot={snapshot} checking={checking} />,
    },
  ]);
  // The host tracks plugin-scope disposals itself; this makes the no-leak
  // guarantee explicit and survives a host that does not.
  api.lifecycle.onDispose(unregisterRoute);

  const commandLayer: unknown = api.keymap.registerLayer({
    commands: [
      {
        name: "plugin-updates.open",
        title: "Plugin updates",
        desc: "Check npm plugins and managed tools for updates",
        category: "Plugins",
        namespace: "palette",
        slashName: "plugin-updates",
        run: () => api.route.navigate(ROUTE_NAME, { returnRoute: api.route.current }),
      },
    ],
    bindings: [],
  });
  if (typeof commandLayer === "function") api.lifecycle.onDispose(commandLayer as () => void);
};

const plugin: TuiPluginModule = {
  id: "supercode.update-checker",
  tui,
};

export default plugin;
