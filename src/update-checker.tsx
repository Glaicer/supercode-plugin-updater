/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { createNpmRegistryPort } from "./checker.ts";
import { createDurableState } from "./durable-state.ts";
import {
  createManagedToolsPort,
  createServerLocalityPort,
  managedCacheDirectory,
  type LocalityPort,
  type ManagedToolsPort,
} from "./managed-tools.ts";
import { connectedLocation, createServerInventoryPort } from "./server-inventory.ts";
import {
  createServerApply,
  rowIdFor,
  settleKey,
  summarizeApply,
  type ServerApply,
} from "./server-apply.ts";
import {
  createServerUpdates,
  effectiveTuiTargets,
  EMPTY_PENDING_TOOLS,
  EMPTY_SERVER_STATE,
  listedRows,
  PENDING_TOOLS_KEY,
  STORAGE_KEY,
  type PendingToolsState,
  type ServerRow,
  type ServerUpdates,
} from "./server-updates.ts";
import {
  createManagedServerPort,
  createServiceControlPort,
  type ManagedServerPort,
  type ServiceControlPort,
} from "./service-control.ts";
import {
  createCliUpdateRunner,
  createTuiPackagePort,
  type CliUpdateRunner,
  type TuiPackagePort,
} from "./tui-packages.ts";
import {
  reinstallConfirmationMessage,
  toolPhaseLabel,
  type PendingTool,
  type ToolReinstallOutcome,
} from "./tool-reinstall.ts";

const ROUTE = "plugin-updates";
const ID = "supercode.update-checker";
// The server re-activates updated plugins asynchronously; the settle poll
// re-reads the inventory until the new generation shows up or this budget
// is spent.
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_DELAY_MS = 500;

function version(row: ServerRow, reinstall?: ToolReinstallOutcome): string {
  // A managed tool mid-reinstall reports its phase, not a version pair.
  if (reinstall !== undefined) return "";
  if (row.status === "update") return `${row.installedVersion ?? "unknown"} → ${row.latestVersion ?? "unknown"}`;
  // An up-to-date plugin reads as its installed version alone; the arrow pair
  // would only repeat what that already says.
  if (row.status === "current") return row.installedVersion ?? "";
  if (row.installedVersion !== undefined && row.latestVersion !== undefined) {
    return `${row.installedVersion} → ${row.latestVersion}`;
  }
  if (row.installedVersion !== undefined) return row.installedVersion;
  if (row.pinnedVersion !== undefined) return row.pinnedVersion;
  return "";
}

function status(row: ServerRow, reinstall?: ToolReinstallOutcome): string {
  // A managed tool mid-reinstall shows the reinstall phase — never "updated"
  // before the cache actually proves a reinstall.
  if (reinstall !== undefined) return toolPhaseLabel(reinstall);
  switch (row.status) {
    case "update":
      return "update available";
    case "current":
      return "";
    case "unknown":
      return `unknown: ${row.reason ?? "unverified"}`;
    case "pinned":
      return `pinned at ${row.pinnedVersion ?? "unknown"} · info only`;
    case "skipped":
      return `skipped: ${row.reason ?? "unsupported"}`;
  }
}

function line(row: ServerRow, reinstall?: ToolReinstallOutcome): string {
  const parts = [row.spec, version(row, reinstall), status(row, reinstall)].filter((part) => part.length > 0);
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
      if (result.unchanged) return "updated · version unchanged";
      if (apply.running()) return "updated";
      if (row.failed !== undefined) return "updated · activation failed";
      const settled = `updated · now ${row.installedVersion ?? "unknown"}`;
      // Package entrypoints never re-resolve inside a running TUI, so a moved
      // installed version is observable while the loaded one stays behind. A
      // listed shared row stands for its TUI half too and carries the notice.
      return row.runtime === "tui" || row.shared === true
        ? `${settled} · restart TUI to activate`
        : settled;
  }
}

function rowLine(
  row: ServerRow,
  index: number,
  cursor: number,
  apply: ServerApply,
  sendable: ReadonlySet<string>,
  reinstall?: ToolReinstallOutcome,
): string {
  const focus = index === cursor ? ">" : " ";
  // A stale mark (the row left the updatable set after a refresh) must not
  // read as a live selection; the send path filters it separately.
  const mark = sendable.has(row.id) ? "*" : " ";
  const result = outcome(row, apply);
  return `${focus}${mark} ${line(row, reinstall)}${result ? `  ·  ${result}` : ""}`;
}

export function createApplyStatus(apply: ServerApply): () => string {
  const [dots, setDots] = createSignal(1);
  createEffect(() => {
    if (!apply.running()) return;
    setDots(1);
    const timer = setInterval(() => setDots((count) => (count % 3) + 1), 500);
    onCleanup(() => clearInterval(timer));
  });
  return () => {
    if (apply.running()) return `Updating plugins${".".repeat(dots())}`;
    const results = apply.results();
    if (results.size === 0) return "";
    const { updated, unverified, unchanged, failed, missing } = summarizeApply(results);
    const suffix = [
      ...(unverified > 0 ? [` · ${unverified} unverified`] : []),
      ...(unchanged > 0 ? [` · ${unchanged} unchanged`] : []),
    ].join("");
    return `Update finished: ${updated} updated${suffix} · ${failed} failed · ${missing} not updated.`;
  };
}

function statusLine(model: ServerUpdates): string {
  if (model.checking()) return "Checking for updates…";
  if (model.error()) return `Check failed: ${model.error()}`;
  if (model.checkFailed()) return "Host check unavailable · update availability unverified.";
  if (model.rows().length === 0) return "No plugins configured.";
  return model.freshness() === "fresh" ? "Checked for updates." : "Showing last check.";
}

function confirmationMessage(rows: readonly ServerRow[]): string {
  // One line per plugin: a shared pair is sent as one target and listed once,
  // preferring the half that actually carries the update.
  const bySpec = new Map<string, ServerRow>();
  for (const row of rows) {
    const kept = bySpec.get(row.spec);
    if (kept === undefined || (kept.status !== "update" && row.status === "update")) bySpec.set(row.spec, row);
  }
  const listing = [...bySpec.values()].map((row) => {
    const pair = version(row);
    return `· ${row.spec}${pair ? ` ${pair}` : ""}`;
  });
  const lines = [...listing];
  if (rows.some((row) => row.runtime === "server")) {
    lines.push("The connected server applies these updates live; plugin behavior changes without a restart.");
  }
  if (rows.some((row) => row.runtime === "tui")) {
    lines.push("TUI packages install a new generation; the running TUI keeps the loaded version until it restarts.");
  }
  if (rows.some((row) => row.shared === true)) {
    lines.push("Shared targets are sent to the CLI once; it re-checks and may update either or both runtimes.");
  }
  lines.push("The screen re-reads the inventory afterwards.");
  return lines.join("\n");
}

function Screen(props: {
  context: Plugin.Context;
  model: ServerUpdates;
  apply: ServerApply;
  managedServer: ManagedServerPort;
  serviceControl: ServiceControlPort;
  cacheDir: string;
  back: () => void;
}) {
  const { context, model, apply, managedServer, serviceControl, cacheDir } = props;
  const [cursor, setCursor] = createSignal(0);
  const applyStatus = createApplyStatus(apply);
  // One membership computation per render, not one per row.
  const sendable = () => new Set(apply.selectedRows(model.rows()).map((row) => row.id));
  // The screen walks the listed rows; the model keeps the hidden halves and
  // local paths for the apply machinery and the settle poll.
  const listed = () => listedRows(model.rows());
  const focus = () => Math.max(0, Math.min(cursor(), listed().length - 1));
  const move = (delta: number) => setCursor(focus() + delta);
  // Managed tools render as their own read-only section after the plugin rows;
  // the model always composes them last.
  const pluginRows = () => listed().filter((row) => row.runtime !== "tool");
  const toolRows = () => listed().filter((row) => row.runtime === "tool");
  const toolsNote = (): string | undefined => {
    const availability = model.toolsAvailability();
    if (availability === undefined) return undefined;
    if (!availability.available) return `unavailable: ${availability.reason}`;
    if (toolRows().length === 0) return "none installed";
    return undefined;
  };

  const confirmUpdates = async () => {
    if (apply.running()) return;
    const rows = apply.selectedPluginRows(model.rows());
    if (rows.length === 0) {
      if (apply.selectedToolRows(model.rows()).length > 0) {
        context.ui.toast.show({ message: "Managed tools use X — reinstall & restart the server." });
      }
      return;
    }
    const choice = await context.ui.dialog.confirm({
      title: "Update plugins",
      message: confirmationMessage(rows),
      label: { confirm: "Update", cancel: "Cancel" },
    });
    if (choice !== true) return;
    await apply.execute(rows);
  };

  const confirmReinstall = async () => {
    const rows = apply.selectedToolRows(model.rows());
    if (rows.length === 0) {
      if (apply.selectedPluginRows(model.rows()).length > 0) {
        context.ui.toast.show({ message: "Plugins use U — update selected." });
      }
      return;
    }
    // The action stops and starts a shared server, so it is only available for
    // the managed local daemon the TUI is provably connected to.
    const verdict = await managedServer.verify();
    if (!verdict.ok) {
      context.ui.toast.show({ message: `Reinstall unavailable: ${verdict.reason}` });
      return;
    }
    const choice = await context.ui.dialog.confirm({
      title: "Reinstall managed tools and restart server",
      message: reinstallConfirmationMessage(
        rows.map((row) => ({
          name: row.name,
          ...(row.installedVersion === undefined ? {} : { installedVersion: row.installedVersion }),
          ...(row.latestVersion === undefined ? {} : { latestVersion: row.latestVersion }),
        })),
      ),
      label: { confirm: "Reinstall & restart", cancel: "Cancel" },
    });
    if (choice !== true) return;
    let pid: number | undefined;
    try {
      pid = (await context.client.server.info()).pid;
    } catch {
      pid = undefined;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      context.ui.toast.show({ message: "Reinstall aborted: the server process is unknown." });
      return;
    }
    // Persist first so the pending state survives the restart, then hand the
    // sequence to a detached supervisor that outlives this handler.
    await model.markToolsPending(
      rows.map((row) => ({
        name: row.name,
        ...(row.installedVersion === undefined ? {} : { previousVersion: row.installedVersion }),
        at: Date.now(),
      })),
    );
    serviceControl.reinstall({ pid, cacheDir, names: rows.map((row) => row.name) });
    apply.clearSelection();
    void pollReinstall();
  };

  const pollReinstall = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await model.reread();
      const pending = toolRows().some((row) => {
        const outcome = model.toolReinstallOutcome(row.name);
        return outcome !== undefined && outcome.phase !== "reinstalled";
      });
      if (!pending) return;
    }
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
          const row = listed()[focus()];
          if (row !== undefined) apply.toggle(row);
        },
      },
      { bind: "a", title: "Select all updatable", run: () => apply.selectAll(model.rows()) },
      { bind: "u", title: "Update selected plugins", run: () => confirmUpdates() },
      { bind: "x", title: "Reinstall tools & restart server", run: () => confirmReinstall() },
    ],
  }));

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1}>
      <text fg={context.theme.text.base}><b>Plugin Updates</b></text>
      <text fg={context.theme.text.muted}>
        {statusLine(model)}  ·  ↑/↓/j/k move · Space select · A select all · U update plugins · X reinstall tools · R refresh · Esc back
      </text>
      <text>{" "}</text>
      <text fg={context.theme.text.muted}>Plugins</text>
      <For each={pluginRows()}>
        {(row, index) => (
          <text fg={context.theme.text.base}>{rowLine(row, index(), focus(), apply, sendable())}</text>
        )}
      </For>
      <Show when={model.toolsAvailability() !== undefined}>
        <text>{" "}</text>
        <text fg={context.theme.text.muted}>
          Managed tools · installed on demand by OpenCode · X reinstalls selected &amp; restarts the server
        </text>
        <For each={toolRows()}>
          {(row, index) => (
            <text fg={context.theme.text.base}>
              {rowLine(row, pluginRows().length + index(), focus(), apply, sendable(), model.toolReinstallOutcome(row.name))}
            </text>
          )}
        </For>
        <Show when={toolsNote() !== undefined}>
          <text fg={context.theme.text.muted}>{toolsNote()}</text>
        </Show>
      </Show>
      <text>{" "}</text>
      <text fg={context.theme.text.muted}>{applyStatus()}</text>
      <text>{" "}</text>
    </box>
  );
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const options = (context.options ?? {}) as {
      registryBaseUrl?: string;
      tuiPackages?: TuiPackagePort;
      runPluginUpdate?: CliUpdateRunner;
      managedTools?: ManagedToolsPort;
      serverLocality?: LocalityPort;
      managedServer?: ManagedServerPort;
      serviceControl?: ServiceControlPort;
    };
    const inventory = createServerInventoryPort(context);
    const tui = options.tuiPackages ?? createTuiPackagePort();
    const tools = options.managedTools ?? createManagedToolsPort();
    const locality = options.serverLocality ?? createServerLocalityPort(context.client);
    const managedServer = options.managedServer ?? createManagedServerPort(context.client);
    const serviceControl = options.serviceControl ?? createServiceControlPort();
    const cacheDir = managedCacheDirectory();
    const model = createServerUpdates({
      inventory,
      tui,
      tools,
      locality,
      state: createDurableState(context.storage, STORAGE_KEY, EMPTY_SERVER_STATE),
      pending: createDurableState<PendingToolsState>(context.storage, PENDING_TOOLS_KEY, EMPTY_PENDING_TOOLS),
      environment: () => connectedLocation(context).directory,
      fetchLatest: createNpmRegistryPort(
        options.registryBaseUrl === undefined ? {} : { baseUrl: options.registryBaseUrl },
      ),
      toast: (message) => context.ui.toast.show({ message }),
    });
    const apply = createServerApply({
      list: inventory.list,
      tuiTargets: async (entries) => effectiveTuiTargets(entries, tui),
      update: (target, signal) =>
        context.client.plugin.update({ location: connectedLocation(context), targets: [target] }, { signal }),
      runCli: options.runPluginUpdate ?? createCliUpdateRunner(),
      location: () => connectedLocation(context).directory,
      checkedEnvironment: () => model.checkedEnvironment(),
      settle: async (applied) => {
        const absent = new Set<string>();
        const confirmed = new Set<string>();
        const unversioned = new Set<string>();
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
          if (!(await model.reread())) {
            return { read: false, absent: [...absent], confirmed: [...confirmed], unversioned: [...unversioned] };
          }
          for (const { target, runtimes } of applied) {
            for (const { runtime, previousVersion } of runtimes) {
              const key = settleKey(runtime, target);
              if (absent.has(key) || confirmed.has(key) || unversioned.has(key)) continue;
              const row = model.rows().find((candidate) => candidate.id === rowIdFor(runtime, target));
              if (row === undefined) {
                absent.add(key);
                continue;
              }
              if (row.installedVersion === undefined) {
                unversioned.add(key);
                continue;
              }
              if (row.installedVersion !== previousVersion) confirmed.add(key);
            }
          }
          const pending = applied
            .flatMap(({ target, runtimes }) => runtimes.map(({ runtime }) => settleKey(runtime, target)))
            .filter((key) => !absent.has(key) && !confirmed.has(key) && !unversioned.has(key));
          if (pending.length === 0 || Date.now() >= deadline) {
            return { read: true, absent: [...absent], confirmed: [...confirmed], unversioned: [...unversioned] };
          }
        }
      },
    });
    let previous: ReturnType<typeof context.ui.router.current> = { type: "home" };
    const unregister = context.ui.router.register({
      name: ROUTE,
      render: () => (
        <Screen
          context={context}
          model={model}
          apply={apply}
          managedServer={managedServer}
          serviceControl={serviceControl}
          cacheDir={cacheDir}
          back={() => context.ui.router.navigate(previous)}
        />
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
            description: "Show plugin and managed-tool versions and updates",
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
