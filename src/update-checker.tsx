/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { For, createSignal } from "solid-js";
import { createNpmRegistryPort } from "./checker.ts";
import { createDurableState } from "./durable-state.ts";
import { connectedLocation, createServerInventoryPort } from "./server-inventory.ts";
import {
  createServerApply,
  type ServerApply,
} from "./server-apply.ts";
import {
  createServerUpdates,
  EMPTY_SERVER_STATE,
  STORAGE_KEY,
  type ServerRow,
  type ServerUpdates,
} from "./server-updates.ts";

const ROUTE = "plugin-updates";
const ID = "supercode.update-checker";
// The server re-activates updated plugins asynchronously; the settle poll
// re-reads the inventory until the new generation shows up or this budget
// is spent.
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_DELAY_MS = 500;

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

/**
 * The apply outcome joins the row currently on screen. While the operation is
 * still running the fresh inventory is not read yet, so an updated row claims
 * no version; an unverified re-read never claims one either.
 */
function outcome(row: ServerRow, apply: ServerApply): string {
  const result = apply.result(row.id);
  if (result === undefined) return "";
  switch (result.phase) {
    case "updating":
      return "updating…";
    case "failed":
      return `failed: ${result.message ?? "update failed"}`;
    case "missing":
      return `not updated${result.message ? `: ${result.message}` : " · not in inventory"}`;
    case "updated":
      if (result.unverified) return "updated · inventory unavailable";
      if (apply.running()) return "updated";
      if (row.failed !== undefined) return "updated · activation failed";
      return `updated · now ${row.installedVersion ?? "unknown"}`;
  }
}

function rowLine(row: ServerRow, index: number, cursor: number, apply: ServerApply): string {
  const focus = index === cursor ? ">" : " ";
  // A stale mark (the row left the updatable set after a refresh) must not
  // read as a live selection; the send path filters it separately.
  const mark = apply.selectedRows([row]).length > 0 ? "*" : " ";
  const result = outcome(row, apply);
  return `${focus}${mark} ${line(row)}${result ? `  ·  ${result}` : ""}`;
}

function applyStatus(apply: ServerApply): string {
  if (apply.running()) return "Updating plugins…";
  const results = [...apply.results().values()];
  if (results.length === 0) return "";
  const updated = results.filter((result) => result.phase === "updated" && !result.unverified).length;
  const unverified = results.filter((result) => result.phase === "updated" && result.unverified).length;
  const failed = results.filter((result) => result.phase === "failed").length;
  const missing = results.filter((result) => result.phase === "missing").length;
  const verified = unverified > 0 ? ` · ${unverified} unverified` : "";
  return `Update finished: ${updated} updated${verified} · ${failed} failed · ${missing} not updated.`;
}

function statusLine(model: ServerUpdates): string {
  if (model.checking()) return "Checking for updates…";
  if (model.error()) return `Check failed: ${model.error()}`;
  if (model.checkFailed()) return "Host check unavailable · update availability unverified.";
  if (model.rows().length === 0) return "No server plugins configured.";
  return model.freshness() === "fresh" ? "Checked for updates." : "Showing last check.";
}

function Screen(props: {
  context: Plugin.Context;
  model: ServerUpdates;
  apply: ServerApply;
  back: () => void;
}) {
  const { context, model, apply } = props;
  const [cursor, setCursor] = createSignal(0);
  const focus = () => Math.max(0, Math.min(cursor(), model.rows().length - 1));
  const move = (delta: number) => setCursor(focus() + delta);

  const confirmUpdates = async () => {
    if (apply.running()) return;
    const rows = apply.selectedRows(model.rows());
    if (rows.length === 0) return;
    const listing = rows.map((row) => {
      const pair = version(row);
      return `· ${row.spec}${pair ? ` ${pair}` : ""}`;
    });
    const choice = await context.ui.dialog.confirm({
      title: "Update server plugins",
      message:
        `The connected server applies these updates live:\n${listing.join("\n")}\n` +
        "Plugin behavior changes without a restart; the screen re-reads the inventory afterwards.",
      label: { confirm: "Update", cancel: "Cancel" },
    });
    if (choice !== true) return;
    await apply.execute(rows);
  };

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { bind: "escape", title: "Back", run: props.back },
      { bind: "r", title: "Refresh", run: () => void model.refresh() },
      { bind: "down", title: "Next plugin", run: () => move(1) },
      { bind: "up", title: "Previous plugin", run: () => move(-1) },
      { bind: "j", title: "Next plugin", run: () => move(1) },
      { bind: "k", title: "Previous plugin", run: () => move(-1) },
      {
        bind: "space",
        title: "Select plugin",
        run: () => {
          const row = model.rows()[focus()];
          if (row !== undefined) apply.toggle(row);
        },
      },
      { bind: "a", title: "Select all updatable", run: () => apply.selectAll(model.rows()) },
      { bind: "u", title: "Update selected", run: () => confirmUpdates() },
    ],
  }));

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1}>
      <text fg={context.theme.text.base}><b>Plugin Updates · Server</b></text>
      <text fg={context.theme.text.muted}>{statusLine(model)}  ·  R refresh · Esc back</text>
      <For each={model.rows()}>
        {(row, index) => <text fg={context.theme.text.base}>{rowLine(row, index(), focus(), apply)}</text>}
      </For>
      <text fg={context.theme.text.muted}>{applyStatus(apply)}</text>
    </box>
  );
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const inventory = createServerInventoryPort(context);
    const model = createServerUpdates({
      inventory,
      state: createDurableState(context.storage, STORAGE_KEY, EMPTY_SERVER_STATE),
      environment: () => connectedLocation(context).directory,
      fetchLatest: createNpmRegistryPort(),
      toast: (message) => context.ui.toast.show({ message }),
    });
    const apply = createServerApply({
      list: inventory.list,
      update: (target, signal) =>
        context.client.plugin.update({ location: connectedLocation(context), targets: [target] }, { signal }),
      settle: async (applied) => {
        const absent = new Set<string>();
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
          if (!(await model.reread())) return { read: false, absent: [...absent] };
          for (const { target } of applied) {
            if (absent.has(target)) continue;
            if (!model.rows().some((candidate) => candidate.spec === target)) absent.add(target);
          }
          const pending = applied.filter(({ target }) => !absent.has(target));
          const confirmed =
            pending.length === 0 ||
            pending.every(({ target, previousVersion }) => {
              const row = model.rows().find((candidate) => candidate.spec === target);
              return row?.installedVersion !== undefined && row.installedVersion !== previousVersion;
            });
          if (confirmed || Date.now() >= deadline) return { read: true, absent: [...absent] };
        }
      },
    });
    let previous: ReturnType<typeof context.ui.router.current> = { type: "home" };
    const unregister = context.ui.router.register({
      name: ROUTE,
      render: () => (
        <Screen context={context} model={model} apply={apply} back={() => context.ui.router.navigate(previous)} />
      ),
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
      apply.dispose();
      model.dispose();
      unregisterSlot();
      unregister();
    };
  },
});
