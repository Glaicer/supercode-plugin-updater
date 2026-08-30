/**
 * supercode.update-checker — TUI plugin for the Update Checker
 * (feature 041, tickets 05 + 06). This file is the View plus registration
 * only: every bit of check logic lives in ./update-model.ts and the
 * selection rules in ./selection.ts (the tested seams).
 *
 * Registration surface (probe-verified on runtime 1.18.21, see
 * .scratch/041-update-checker/probe/RESULTS.md):
 * - `api.route.register` mounts the `/plugin-updates` screen; `register`
 *   returns an unsubscribe, wired to `lifecycle.onDispose` so a plugin
 *   reload cannot leak a stale route.
 * - `api.keymap.registerLayer` adds the command-palette entry; `slashName`
 *   makes it reachable as `/plugin-updates`. The command only navigates —
 *   the host's own diff-viewer uses the same registerLayer + navigate shape.
 * - The screen binds its keys for as long as it is mounted: the layer is
 *   registered in `onMount` and unregistered in `onCleanup`, so bindings
 *   never fire outside the route. Closing returns to the route the palette
 *   was opened from (home when there is none).
 *
 * Interactivity (ticket 06): Space toggles the row under the cursor,
 * `A` selects every selectable candidate (checked Floating plugins and
 * Managed Tools only — pinned, unknown, and skipped never enter the
 * selection, US 11–13), `U` opens a `ui.DialogConfirm` over the selection
 * and on confirm hands it to `model.confirm` (Pending Invalidation in kv +
 * one prepared toast; nothing on disk until dispose, ADR 0016), `R` runs a
 * manual model cycle ignoring the TTL with no toast, Esc closes.
 *
 * On open the screen renders the stored `available` snapshot from kv
 * immediately — no network wait (US 29). While a check cycle is running
 * (startup or manual), an indicator line shows above the list (US 28); when
 * the cycle settles, the snapshot is re-read and the list updates. After a
 * confirmed update the screen shows a pending-restart banner (US 18).
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
  createUpdateModel,
  PREPARED_TOAST_MESSAGE,
  type CheckResult,
  type SkippedSpec,
  type UpdateCandidate,
  type UpdateModel,
} from "./update-model.ts";
import { createSelection, isSelectable, type PendingEntry } from "./selection.ts";

const ROUTE_NAME = "plugin-updates";

/** Selection lists longer than this get the large dialog preset. */
const LARGE_DIALOG_MAX_ROWS = 6;

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

/** One selectable candidate line: cursor marker, checkbox, spec, version pair. */
function SelectableRow(props: {
  api: TuiPluginApi;
  candidate: UpdateCandidate;
  selected: boolean;
  focused: boolean;
}) {
  const theme = () => props.api.theme.current;
  const c = () => props.candidate;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme().primary}>{props.focused ? "❯" : " "}</text>
        <text fg={props.selected ? theme().success : theme().textMuted}>
          {props.selected ? "[x]" : "[ ]"}
        </text>
        <text fg={theme().text}>{c().spec}</text>
      </box>
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
    </box>
  );
}

/**
 * One info-only candidate line — Pinned (badge, US 11) or unknown (status
 * string, US 22). Leading blanks keep the spec column aligned with the
 * checkbox rows; no cursor, no checkbox — never selectable.
 */
function InfoRow(props: { api: TuiPluginApi; candidate: UpdateCandidate }) {
  const theme = () => props.api.theme.current;
  const c = () => props.candidate;
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text>{" "}</text>
        <text>{"   "}</text>
        <text fg={theme().textMuted}>{c().spec}</text>
      </box>
      <Show
        when={c().status === "pinned"}
        fallback={
          <text fg={theme().warning}>{`unknown — ${c().reason ?? "no data"}`}</text>
        }
      >
        <text fg={theme().textMuted}>{`pinned at ${c().pinnedVersion ?? "?"}`}</text>
      </Show>
    </box>
  );
}

function CandidateRow(props: {
  api: TuiPluginApi;
  candidate: UpdateCandidate;
  selected: boolean;
  focused: boolean;
}) {
  return (
    <Show
      when={isSelectable(props.candidate)}
      fallback={<InfoRow api={props.api} candidate={props.candidate} />}
    >
      <SelectableRow api={props.api} candidate={props.candidate} selected={props.selected} focused={props.focused} />
    </Show>
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
  model: UpdateModel;
  snapshot: () => CheckResult | undefined;
  checking: () => boolean;
  /** One manual model cycle (ignores TTL, never toasts) with indicator wiring. */
  refresh: () => Promise<void>;
}) {
  const theme = () => props.api.theme.current;
  const candidates = () => props.snapshot()?.candidates ?? [];
  const plugins = () => candidates().filter((c) => c.kind === "plugin");
  const tools = () => candidates().filter((c) => c.kind === "tool");
  const skipped = () => props.snapshot()?.skipped ?? [];
  const selectable = () => candidates().filter(isSelectable);
  const nothingStored = () => !props.snapshot() && !props.checking();

  const selection = createSelection();
  // The selection store is intentionally unreactive (pure, tested); this
  // version bump is what makes checkbox reads track mutations.
  const [version, setVersion] = createSignal(0);
  const mutate = (fn: () => void) => {
    fn();
    setVersion(version() + 1);
  };
  const isSelected = (candidate: UpdateCandidate): boolean => {
    version();
    return selection.has(candidate);
  };

  const [cursor, setCursor] = createSignal(0);
  // A refresh can shrink the list; keep the cursor inside it (or at 0).
  createEffect(() => {
    const length = selectable().length;
    if (cursor() >= length) setCursor(Math.max(0, length - 1));
  });

  // Survives remounts: derived from the model's state machine on mount, so
  // reopening the screen while updates are pending still shows the banner.
  const [prepared, setPrepared] = createSignal(props.model.state === "pending-restart");

  const move = (delta: number) => {
    const rows = selectable();
    if (rows.length === 0) return;
    setCursor(Math.min(rows.length - 1, Math.max(0, cursor() + delta)));
  };
  const toggle = () => {
    const current = selectable()[cursor()];
    if (current) mutate(() => selection.toggle(current));
  };
  const selectAll = () => mutate(() => selection.selectAll(candidates()));
  const update = () => {
    // `U` with nothing selectable marked is a no-op — no dialog, no error.
    if (selection.isEmpty(candidates())) return;
    openConfirm(selection.selectedEntries(candidates()));
  };
  const manualRefresh = () => {
    // One cycle at a time: a manual R never overlaps the startup cycle or
    // another R (the model dedupes only start()).
    if (props.checking()) return;
    void props.refresh();
  };

  // Key layer lifecycle: registered while mounted, unregistered while the
  // confirm dialog is open, so screen keys never race the dialog's own
  // bindings regardless of how the host scopes layer dispatch.
  let unregisterKeys: (() => void) | undefined;
  let disposed = false;
  const registerKeys = () => {
    if (disposed || unregisterKeys) return;
    const result: unknown = props.api.keymap.registerLayer({
      commands: [
        { name: "plugin-updates.close", desc: "Close the plugin updates screen", run: () => goBack(props.api) },
        { name: "plugin-updates.cursor-up", desc: "Previous package", run: () => move(-1) },
        { name: "plugin-updates.cursor-down", desc: "Next package", run: () => move(1) },
        { name: "plugin-updates.toggle", desc: "Toggle the highlighted package", run: toggle },
        { name: "plugin-updates.select-all", desc: "Select all selectable packages", run: selectAll },
        { name: "plugin-updates.update", desc: "Prepare updates for the selected packages", run: update },
        { name: "plugin-updates.refresh", desc: "Re-check for updates now", run: manualRefresh },
      ],
      bindings: [
        { key: "escape", cmd: "plugin-updates.close", desc: "Close", group: "Plugin Updates" },
        { key: "up", cmd: "plugin-updates.cursor-up", desc: "Previous", group: "Plugin Updates" },
        { key: "k", cmd: "plugin-updates.cursor-up", desc: "Previous", group: "Plugin Updates" },
        { key: "down", cmd: "plugin-updates.cursor-down", desc: "Next", group: "Plugin Updates" },
        { key: "j", cmd: "plugin-updates.cursor-down", desc: "Next", group: "Plugin Updates" },
        { key: "space", cmd: "plugin-updates.toggle", desc: "Toggle", group: "Plugin Updates" },
        { key: "a", cmd: "plugin-updates.select-all", desc: "Select all", group: "Plugin Updates" },
        { key: "u", cmd: "plugin-updates.update", desc: "Update selected", group: "Plugin Updates" },
        { key: "r", cmd: "plugin-updates.refresh", desc: "Refresh", group: "Plugin Updates" },
      ],
    });
    unregisterKeys = typeof result === "function" ? (result as () => void) : undefined;
  };
  const pauseKeys = () => {
    unregisterKeys?.();
    unregisterKeys = undefined;
  };

  /**
   * The confirm dialog (US 17): `ui.DialogConfirm` rendered into the host's
   * dialog stack via `ui.dialog.replace`. Every path out of the dialog —
   * confirm, cancel, Esc — fires the `replace` onClose callback (the host
   * calls it on clear too), so the promise settles through one `finish`
   * gate: first callback wins, the rest are swallowed. Keys resume via a
   * microtask, after the dialog's own binding handler has closed it.
   */
  function openConfirm(entries: readonly PendingEntry[]): void {
    pauseKeys();
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      queueMicrotask(registerKeys);
      if (!confirmed) return;
      props.model.confirm(entries);
      setPrepared(true);
      mutate(() => selection.clear());
    };
    props.api.ui.dialog.replace(
      () =>
        props.api.ui.DialogConfirm({
          title: "Prepare updates?",
          message: `Their cached versions will be removed when OpenCode exits; fresh ones install on the next start:\n${entries.map((entry) => entry.spec).join("\n")}`,
          onConfirm: () => finish(true),
          onCancel: () => finish(false),
        }),
      () => finish(false),
    );
    if (entries.length > LARGE_DIALOG_MAX_ROWS) props.api.ui.dialog.setSize("large");
  }

  // Bindings live only while this screen is mounted: registered on mount,
  // unregistered on unmount (also covering the dialog-open window), so they
  // never leak to other routes — and a mid-dialog unmount cannot have the
  // queued key resume re-register a dead screen.
  onMount(registerKeys);
  onCleanup(() => {
    disposed = true;
    pauseKeys();
  });

  const focusedCandidate = () => selectable()[cursor()];
  const hints = "space toggle · a select all · u update · r refresh · esc close";

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text fg={theme().primary} attributes={TextAttributes.BOLD}>
        Plugin Updates
      </text>
      <text fg={theme().textMuted}>{hints}</text>
      <Show when={prepared()}>
        <text fg={theme().success}>{PREPARED_TOAST_MESSAGE}</text>
      </Show>
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
          <For each={plugins()}>
            {(candidate) => (
              <CandidateRow
                api={props.api}
                candidate={candidate}
                selected={isSelected(candidate)}
                focused={focusedCandidate() === candidate}
              />
            )}
          </For>
        </Group>
        <Group api={props.api} title="Managed tools">
          <For each={tools()}>
            {(candidate) => (
              <CandidateRow
                api={props.api}
                candidate={candidate}
                selected={isSelected(candidate)}
                focused={focusedCandidate() === candidate}
              />
            )}
          </For>
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

  // One model cycle wired to the screen indicator: the result lands in the
  // snapshot when the cycle settles. A failed cycle (registry down
  // entirely) keeps the previous snapshot — the screen stays usable.
  const refresh = async (): Promise<void> => {
    setChecking(true);
    try {
      await model.runCheck();
    } catch {
      // Per-package failures isolate to unknown candidates; a total
      // failure persists nothing — keep showing the previous result.
    } finally {
      setSnapshot(model.getSnapshot());
      setChecking(false);
    }
  };

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
      render: () => <UpdatesScreen api={api} model={model} snapshot={snapshot} checking={checking} refresh={refresh} />,
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
