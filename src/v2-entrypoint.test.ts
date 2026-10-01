import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import { createManagedToolsPort, createServerLocalityPort } from "./managed-tools.ts";
import { summarizeApply, type ApplyResult, type ServerApply } from "./server-apply.ts";
import { listedRows, type ServerRow, type ServerUpdates } from "./server-updates.ts";
import type { CliUpdateResult, TuiPackagePort } from "./tui-packages.ts";
import { installGeneration } from "./test-generations.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opentui/solid") {
      return { url: pathToFileURL(join(root, "src/solid-stub.js")).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const plugin = (await import(pathToFileURL(join(root, "dist/update-checker.js")).href)).default as {
  id: string;
  setup(context: Plugin.Context): void | (() => void);
};

const ROUTE = "plugin-updates";
const START = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Command {
  bind?: string;
  id?: string;
  title?: string;
  run(input?: string, event?: unknown): unknown;
}

interface Layer {
  commands?: Command[];
}

interface ConfirmOptions {
  title: string;
  message: string;
  label?: { confirm?: string; cancel?: string };
}

interface Setup {
  model: ServerUpdates;
  apply: ServerApply;
  screen: {
    component: (props: { model: ServerUpdates; apply: ServerApply; back(): void }) => unknown;
    props: { model: ServerUpdates; apply: ServerApply; back(): void };
  };
  cleanup: () => void;
  layers: Array<() => Layer>;
  destinations: unknown[];
  page(): unknown;
  slot(): unknown;
}

interface Backing {
  files: Map<string, string>;
}

interface CliCall {
  target: string;
  cwd: string;
  signal?: AbortSignal;
}

interface Host {
  backing: Backing;
  toasts: Array<{ message: string }>;
  fetches: Array<{ name: string; url: string; signal?: AbortSignal }>;
  registry: Map<string, () => Promise<unknown> | unknown>;
  requests: {
    list: Array<{ location: unknown; signal?: AbortSignal }>;
    check: Array<{ location: unknown; signal?: AbortSignal }>;
    update: Array<{ location: unknown; targets: string[]; signal?: AbortSignal }>;
    info: Array<{ signal?: AbortSignal }>;
  };
  cliCalls: CliCall[];
  tui: {
    targets: string[];
    versions: Map<string, string>;
    exposed: Map<string, boolean>;
  };
  cacheDir: string;
  confirms: ConfirmOptions[];
  storageKeys: string[];
  setLocation(directory: string): void;
  setList(handler: () => Promise<{ data: unknown[] }>): void;
  setCheck(handler: () => Promise<{ data: unknown[] }>): void;
  setUpdate(handler: (target: string) => Promise<void>): void;
  setCli(handler: (target: string, cwd: string, signal?: AbortSignal) => CliUpdateResult | Promise<CliUpdateResult>): void;
  setConfirm(handler: (options: ConfirmOptions) => boolean | undefined | Promise<boolean | undefined>): void;
  setServerInfo(handler: () => Promise<unknown> | unknown): void;
  setup(): Setup;
}

function packageInfo(
  target: string,
  options: { version?: string; outdated?: boolean; failed?: string; tui?: boolean } = {},
) {
  return {
    source: {
      type: "package",
      target,
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.outdated ? { outdated: true } : {}),
    },
    ...(options.tui ? { features: { tui: true } } : {}),
    state: options.failed === undefined ? { status: "active" } : { status: "failed", error: options.failed },
  };
}

function localInfo(path: string) {
  return { id: path, source: { type: "local", path }, state: { status: "active" } };
}

function sdkInfo(id: string) {
  return { id, source: { type: "sdk" }, state: { status: "active" } };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/**
 * Drives a mocked settle poll: the poll sleeps on the mocked clock, so each
 * tick advances one 500ms step while the flushes let the re-read settle.
 */
async function driveClock(t: TestContext, run: () => Promise<unknown>, steps = 40): Promise<void> {
  const pending = run();
  for (let step = 0; step < steps; step++) {
    await flush(20);
    t.mock.timers.tick(500);
  }
  await pending;
}

function rowById(setup: Setup, id: string): ServerRow | undefined {
  return setup.model.rows().find((row) => row.id === id);
}

function commandByBind(setup: Setup, key: string): Command {
  const command = setup.layers
    .flatMap((layer) => layer().commands ?? [])
    .find((candidate) => candidate.bind === key || candidate.id === key);
  assert.ok(command, `no keymap command bound to ${key}`);
  return command;
}

function rowsBySpec(setup: Setup): Map<string, ServerRow> {
  return new Map(setup.model.rows().map((row) => [row.spec, row]));
}

function toolRows(setup: Setup): ServerRow[] {
  return setup.model.rows().filter((row) => row.runtime === "tool");
}

function createHost(
  t: TestContext,
  options: { location?: string; inventory?: unknown[]; checked?: unknown[]; backing?: Backing } = {},
): Host {
  let location = options.location ?? "/connected/project";
  const backing: Backing = options.backing ?? { files: new Map() };
  const toasts: Host["toasts"] = [];
  const fetches: Host["fetches"] = [];
  const registry: Host["registry"] = new Map();
  const requests: Host["requests"] = { list: [], check: [], update: [], info: [] };
  const cliCalls: Host["cliCalls"] = [];
  const tui: Host["tui"] = { targets: [], versions: new Map(), exposed: new Map() };
  const storageKeys: string[] = [];
  const confirms: ConfirmOptions[] = [];
  let listHandler = async () => ({ data: options.inventory ?? [] });
  let checkHandler = async () => ({ data: options.checked ?? options.inventory ?? [] });
  let updateHandler = async (_target: string) => {};
  let cliHandler: (target: string, cwd: string, signal?: AbortSignal) => CliUpdateResult | Promise<CliUpdateResult> =
    async () => ({ code: 0, stdout: "", stderr: "" });
  let confirmHandler: (options: ConfirmOptions) => boolean | undefined | Promise<boolean | undefined> = async () =>
    false;
  // The default identity describes this machine, so the real locality port
  // verifies it as local and the section reads the host's tmp cache.
  const tmpBase = mkdtempSync(join(tmpdir(), "update-checker-"));
  const tmpRoot = join(tmpBase, "tmp-root");
  const cacheDir = join(tmpBase, "cache", "opencode");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  t.after(() => rmSync(tmpBase, { recursive: true, force: true }));
  let infoHandler: () => Promise<unknown> | unknown = async () => ({
    version: "2.0.16",
    pid: process.pid,
    urls: ["http://127.0.0.1:4099"],
    paths: { tmp: tmpRoot },
  });

  const tuiPackages: TuiPackagePort = {
    cliTargets: () => [...tui.targets],
    installedVersion: (target) => tui.versions.get(target),
    exposesTui: (target) => tui.exposed.get(target) ?? tui.versions.has(target),
  };

  const client = {
    plugin: {
      list: (input: { location?: unknown }, requestOptions?: { signal?: AbortSignal }) => {
        requests.list.push({ location: input?.location, signal: requestOptions?.signal });
        return listHandler();
      },
      check: (input: { location?: unknown }, requestOptions?: { signal?: AbortSignal }) => {
        requests.check.push({ location: input?.location, signal: requestOptions?.signal });
        return checkHandler();
      },
      update: (input: { location?: unknown; targets: string[] }, requestOptions?: { signal?: AbortSignal }) => {
        requests.update.push({
          location: input?.location,
          targets: [...(input?.targets ?? [])],
          signal: requestOptions?.signal,
        });
        const [target] = input?.targets ?? [];
        return updateHandler(target ?? "");
      },
    },
    server: {
      info: (requestOptions?: { signal?: AbortSignal }) => {
        requests.info.push({ signal: requestOptions?.signal });
        return infoHandler();
      },
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { signal?: AbortSignal }) => {
    const text = String(url);
    const name = decodeURIComponent(text.split("/").at(-2) ?? "");
    fetches.push({ name, url: text, signal: init?.signal });
    const responder = registry.get(name);
    if (!responder) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => await responder() } as Response;
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  function setup(): Setup {
    let page: { render(input: object): unknown } | undefined;
    let slot: { render(input: object): unknown } | undefined;
    const layers: Array<() => Layer> = [];
    const destinations: unknown[] = [];
    const previous = { type: "session", sessionID: "ses_test" };
    const current: Record<string, unknown> = { ...previous };

    const storage = {
      store<Value extends object>(key: string, storeOptions: { initial: Value }) {
        storageKeys.push(key);
        const currentValue = backing.files.has(key)
          ? (JSON.parse(backing.files.get(key) as string) as Value)
          : structuredClone(storeOptions.initial);
        return [
          currentValue,
          async (mutation: (draft: Value) => void) => {
            mutation(currentValue);
            backing.files.set(key, JSON.stringify(currentValue));
          },
        ] as const;
      },
    };

    const context = {
      options: {
        tuiPackages,
        runPluginUpdate: async (target: string, cwd: string, signal?: AbortSignal) => {
          cliCalls.push({ target, cwd, signal });
          return cliHandler(target, cwd, signal);
        },
        managedTools: createManagedToolsPort({ cacheDir }),
        serverLocality: createServerLocalityPort(client as unknown as Plugin.Context["client"], {
          tmpRoot: () => tmpRoot,
        }),
      },
      location: {
        get directory() {
          return location;
        },
      },
      data: {
        location: {
          default: () => {
            throw Error("should use current location");
          },
        },
      },
      client: client as unknown as Plugin.Context["client"],
      storage,
      ui: {
        dialog: {
          confirm: (dialogOptions: ConfirmOptions) => {
            confirms.push(dialogOptions);
            return Promise.resolve(confirmHandler(dialogOptions));
          },
        },
        toast: {
          show: (toastOptions: { message: string }) => {
            toasts.push({ message: toastOptions.message });
          },
        },
        slot: (registered: typeof slot) => {
          slot = registered;
          return () => {
            slot = undefined;
          };
        },
        router: {
          register: (registered: typeof page) => {
            page = registered;
            return () => {
              page = undefined;
            };
          },
          current: () => current,
          navigate: (destination: unknown) => {
            destinations.push({ ...(destination as object) });
            for (const key of Object.keys(current)) delete current[key];
            Object.assign(current, destination);
            if (current.type === "plugin" && current.name === ROUTE) current.id = "supercode.update-checker";
          },
        },
      },
      keymap: {
        layer: (layer: (typeof layers)[number]) => {
          layers.push(layer);
        },
      },
      theme: { text: { base: "", muted: "" } },
    } as unknown as Plugin.Context;

    const cleanup = plugin.setup(context) as () => void;
    slot?.render({});
    const rendered = page?.render({}) as Setup["screen"];
    // The host mounts the rendered page, which registers the screen's keymap layer.
    rendered?.component(rendered.props);
    return {
      model: rendered.props.model,
      apply: rendered.props.apply,
      screen: rendered,
      cleanup,
      layers,
      destinations,
      page: () => page,
      slot: () => slot,
    };
  }

  return {
    backing,
    toasts,
    fetches,
    registry,
    requests,
    cliCalls,
    tui,
    cacheDir,
    confirms,
    storageKeys,
    setLocation: (directory) => {
      location = directory;
    },
    setList: (handler) => {
      listHandler = handler;
    },
    setCheck: (handler) => {
      checkHandler = handler;
    },
    setUpdate: (handler) => {
      updateHandler = handler;
    },
    setCli: (handler) => {
      cliHandler = handler;
    },
    setConfirm: (handler) => {
      confirmHandler = handler;
    },
    setServerInfo: (handler) => {
      infoHandler = handler;
    },
    setup,
  };
}

test("the automatic cycle composes installed/latest, toasts once, and the screen opens and returns", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("example", { version: "1.0.0" })],
    checked: [packageInfo("example", { version: "1.0.0", outdated: true })],
  });
  host.registry.set("example", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  assert.equal(host.requests.list.length, 0); // setup never waits for the network
  await setup.model.start();

  assert.equal(setup.model.checking(), false);
  assert.equal(setup.model.freshness(), "fresh");
  assert.equal(setup.model.error(), "");
  assert.equal(setup.model.updateCount(), 1);
  const [row] = setup.model.rows();
  assert.equal(row?.status, "update");
  assert.equal(row?.spec, "example");
  assert.equal(row?.installedVersion, "1.0.0");
  assert.equal(row?.latestVersion, "1.1.0");
  assert.deepEqual(host.toasts, [{ message: "1 OpenCode updates available. Run /plugin-updates to review them." }]);
  assert.deepEqual(host.requests.list.map((call) => call.location), [{ directory: "/connected/project" }]);
  assert.equal(host.requests.check.length, 1);

  commandByBind(setup, "supercode.plugin-updates.open").run();
  assert.deepEqual(setup.destinations, [{ type: "plugin", name: ROUTE }]);
  assert.equal(setup.page() === undefined, false);

  setup.screen.component(setup.screen.props);
  commandByBind(setup, "escape").run();
  assert.deepEqual(setup.destinations.at(-1), { type: "session", sessionID: "ses_test" });
});

test("a fresh 24h snapshot for the same inventory is restored on restart without another cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("example", { version: "1.0.0" })],
    checked: [packageInfo("example", { version: "1.0.0", outdated: true })],
  });
  host.registry.set("example", () => ({ version: "1.1.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(host.requests.check.length, 1);
  assert.equal(host.toasts.length, 1);

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  assert.equal(second.model.freshness(), "stale"); // a snapshot is not a verified cycle

  await second.model.start();
  assert.equal(host.requests.list.length, 2); // the inventory is re-read to compare targets
  assert.equal(host.requests.check.length, 1); // but the cycle does not repeat
  assert.equal(host.toasts.length, 1);
  assert.equal(second.model.freshness(), "fresh");
  assert.equal(second.model.updateCount(), 1);
  assert.deepEqual(second.model.rows(), first.model.rows());
});

test("a new target or another location is never hidden behind a foreign fresh TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("a-pkg", { version: "1.0.0" })],
    checked: [packageInfo("a-pkg", { version: "1.0.0" })],
  });
  host.registry.set("a-pkg", () => ({ version: "1.0.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(host.requests.check.length, 1);

  // A new target in the same inventory.
  t.mock.timers.setTime(START + HOUR);
  const changed = [packageInfo("a-pkg", { version: "1.0.0" }), packageInfo("b-pkg", { version: "4.0.0", outdated: true })];
  host.setList(async () => ({ data: changed }));
  host.setCheck(async () => ({ data: changed }));
  host.registry.set("b-pkg", () => ({ version: "5.0.0" }));
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 2);
  assert.equal(rowsBySpec(second).get("b-pkg")?.status, "update");
  assert.equal(host.toasts.length, 1); // the first cycle had no updates; this one toasts once

  // A different environment over the same durable storage.
  t.mock.timers.setTime(START + 2 * HOUR);
  host.setLocation("/project/other");
  host.setList(async () => ({ data: [packageInfo("c-pkg", { version: "1.0.0" })] }));
  host.setCheck(async () => ({ data: [packageInfo("c-pkg", { version: "1.0.0" })] }));
  host.registry.set("c-pkg", () => ({ version: "1.0.0" }));
  const third = host.setup();
  assert.equal(third.model.rows().length, 0); // no snapshot transfer between locations
  await third.model.start();
  assert.equal(host.requests.check.length, 3);
  assert.deepEqual(third.model.rows().map((row) => row.spec), ["c-pkg"]);
});

test("only floating specs reach the public registry; pinned is info-only; the rest are skipped with reasons", async (t) => {
  const inventory = [
    packageInfo("floating", { version: "1.0.0" }),
    packageInfo("pinned@2.3.0", { version: "2.3.0" }),
    packageInfo("ranged@^1.0.0", { version: "1.4.0" }),
    packageInfo("git+ssh://git@example.com/private/repo.git"),
    localInfo("/home/me/plugins/local"),
    sdkInfo("sdk-one"),
  ];
  const checked = [
    packageInfo("floating", { version: "1.0.0", outdated: true }),
    ...inventory.slice(1),
  ];
  const host = createHost(t, { inventory, checked });
  host.registry.set("floating", () => ({ version: "1.2.0" }));
  host.registry.set("pinned", () => {
    throw Error("pinned must not be looked up");
  });

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(host.fetches.map((fetch) => fetch.name), ["floating"]);
  const rows = rowsBySpec(setup);
  assert.equal(rows.get("floating")?.status, "update");
  assert.equal(rows.get("floating")?.latestVersion, "1.2.0");
  assert.equal(rows.get("pinned@2.3.0")?.status, "pinned");
  assert.equal(rows.get("pinned@2.3.0")?.pinnedVersion, "2.3.0");
  assert.equal(rows.get("ranged@^1.0.0")?.status, "skipped");
  assert.equal(rows.get("ranged@^1.0.0")?.reason, "semver range");
  assert.equal(rows.get("git+ssh://git@example.com/private/repo.git")?.status, "skipped");
  assert.equal(rows.get("git+ssh://git@example.com/private/repo.git")?.reason, "git URL");
  assert.equal(rows.get("/home/me/plugins/local")?.status, "skipped");
  assert.equal(rows.get("/home/me/plugins/local")?.reason, "local path");
  assert.equal(rows.get("sdk-one")?.status, "skipped");
  assert.equal(rows.get("sdk-one")?.reason, "sdk plugin");
});

test("registry lookups share one fixed pool of four", async (t) => {
  const names = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const host = createHost(t, { inventory: names.map((name) => packageInfo(name, { version: "1.0.0" })) });
  const gates = names.map(() => deferred<unknown>());
  let active = 0;
  let peak = 0;
  names.forEach((name, index) => {
    host.registry.set(name, async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await gates[index]?.promise;
      } finally {
        active--;
      }
    });
  });

  const setup = host.setup();
  const pending = setup.model.start();
  await flush();
  assert.equal(host.fetches.length, 4); // four workers started, two targets still queued
  for (const gate of gates) gate.resolve({ version: "1.0.0" });
  await pending;
  assert.equal(host.fetches.length, 6);
  assert.equal(peak, 4);
});

test("a registry lookup that outlives the five second budget becomes unknown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("slow", { version: "1.0.0" })],
    checked: [packageInfo("slow", { version: "1.0.0" })],
  });
  host.registry.set("slow", () => new Promise(() => {}));

  const setup = host.setup();
  const pending = setup.model.start();
  await flush();
  assert.equal(host.fetches.length, 1);

  t.mock.timers.tick(5000);
  await pending;
  const [row] = setup.model.rows();
  assert.equal(row?.status, "unknown");
  assert.equal(row?.reason, "registry lookup failed");
  assert.equal(setup.model.freshness(), "stale"); // no evidence from this cycle
});

test("host outdated and registry metadata stay distinct through failures", async (t) => {
  const inventory = [
    packageInfo("confirmed", { version: "1.0.0" }),
    packageInfo("silent", { version: "1.0.0" }),
    packageInfo("garbage", { version: "1.0.0" }),
    packageInfo("same", { version: "1.0.0" }),
    packageInfo("noversion"),
  ];
  const checked = [
    packageInfo("confirmed", { version: "1.0.0", outdated: true }),
    ...inventory.slice(1),
  ];
  const host = createHost(t, { inventory, checked });
  host.registry.set("confirmed", () => {
    throw Error("registry offline");
  });
  host.registry.set("silent", () => {
    throw Error("registry offline");
  });
  host.registry.set("garbage", () => ({ version: "not-a-version" }));
  host.registry.set("same", () => ({ version: "1.0.0" }));
  host.registry.set("noversion", () => ({ version: "1.0.0" }));

  const setup = host.setup();
  await setup.model.start();

  const rows = rowsBySpec(setup);
  // A host-confirmed update is not hidden by unavailable registry metadata.
  assert.equal(rows.get("confirmed")?.status, "update");
  assert.equal(rows.get("confirmed")?.latestVersion, undefined);
  // Without metadata there is no proof of absence, so the row is unknown, not current.
  assert.equal(rows.get("silent")?.status, "unknown");
  assert.equal(rows.get("silent")?.reason, "registry lookup failed");
  assert.equal(rows.get("garbage")?.status, "unknown");
  assert.equal(rows.get("garbage")?.reason, "version not parseable");
  assert.equal(rows.get("noversion")?.status, "unknown");
  assert.equal(rows.get("noversion")?.reason, "installed version unavailable");
  // Metadata equality corroborates the host's silence.
  assert.equal(rows.get("same")?.status, "current");
});

test("a cycle without evidence keeps the TTL stale and retries after restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const inventory = [packageInfo("example", { version: "1.0.0" })];
  const host = createHost(t, { inventory, checked: inventory });
  host.registry.set("example", () => {
    throw Error("registry offline");
  });

  const first = host.setup();
  await first.model.start();
  assert.equal(first.model.freshness(), "stale");
  assert.equal(host.toasts.length, 0);
  assert.equal(host.requests.check.length, 1);

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 2); // the fresh clock did not lock the retry out
  assert.equal(host.toasts.length, 0);
});

test("a failed host check is surfaced and never advances the TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const inventory = [packageInfo("example", { version: "1.0.0" })];
  const host = createHost(t, { inventory });
  host.setCheck(async () => {
    throw Error("server offline");
  });
  host.registry.set("example", () => ({ version: "1.0.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(first.model.checkFailed(), true);
  assert.equal(first.model.error(), "");
  assert.equal(first.model.freshness(), "stale");
  assert.equal(rowsBySpec(first).get("example")?.status, "current"); // only the metadata source spoke

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 2);
});

test("R ignores a fresh TTL, keeps the snapshot visible, merges concurrent presses, and never toasts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("example", { version: "1.0.0" })],
    checked: [packageInfo("example", { version: "1.0.0", outdated: true })],
  });
  host.registry.set("example", () => ({ version: "1.1.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(host.toasts.length, 1);

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 1); // TTL short-circuit
  second.screen.component(second.screen.props);

  const gate = deferred<{ data: unknown[] }>();
  host.setCheck(() => gate.promise);
  const refresh = commandByBind(second, "r");
  refresh.run();
  const pending = second.model.refresh();
  await flush();
  assert.equal(second.model.checking(), true);
  assert.equal(second.model.rows().length, 1); // the snapshot stays on screen while checking
  assert.equal(second.model.rows()[0]?.status, "update");
  refresh.run(); // a concurrent press joins the same cycle
  await flush();
  assert.equal(host.requests.check.length, 2);

  gate.resolve({ data: [packageInfo("example", { version: "1.0.0", outdated: true })] });
  await pending;
  assert.equal(second.model.checking(), false);
  assert.equal(host.toasts.length, 1); // manual cycles never toast
});

test("an R press during the automatic cycle does not silence its toast", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const gate = deferred<{ data: unknown[] }>();
  const host = createHost(t, {
    inventory: [packageInfo("example", { version: "1.0.0" })],
    checked: [packageInfo("example", { version: "1.0.0", outdated: true })],
  });
  host.registry.set("example", () => ({ version: "1.1.0" }));
  host.setList(() => gate.promise);

  const setup = host.setup();
  const automatic = setup.model.start();
  await flush();
  const manual = setup.model.refresh(); // joins the in-flight automatic cycle
  gate.resolve({ data: [packageInfo("example", { version: "1.0.0" })] });
  await manual;
  await automatic;

  assert.equal(host.toasts.length, 1);
  assert.equal(rowsBySpec(setup).get("example")?.status, "update");
});

test("restart over an old TTL runs a fresh cycle and one automatic toast", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, {
    inventory: [packageInfo("example", { version: "1.0.0" })],
    checked: [packageInfo("example", { version: "1.0.0", outdated: true })],
  });
  host.registry.set("example", () => ({ version: "1.1.0" }));
  const first = host.setup();
  await first.model.start();

  host.setCheck(async () => ({ data: [packageInfo("example", { version: "1.1.0" })] }));
  host.registry.set("example", () => ({ version: "1.1.0" }));
  t.mock.timers.setTime(START + DAY + 1);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 2); // the old TTL did not lock the cycle out
  assert.equal(host.toasts.length, 1); // no updates in the second cycle: silence
  assert.equal(rowsBySpec(second).get("example")?.status, "current");
});

test("empty inventory renders empty without a host check and still records the cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, { inventory: [] });
  const setup = host.setup();
  await setup.model.start();
  assert.equal(setup.model.rows().length, 0);
  assert.equal(setup.model.error(), "");
  assert.equal(host.requests.check.length, 0);
  assert.equal(host.toasts.length, 0);

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.list.length, 2);
  assert.equal(second.model.freshness(), "fresh");
  assert.equal(second.model.rows().length, 0);
});

test("V1 keys in the host store are neither read, executed, nor merged into the V2 snapshot", async (t) => {
  const host = createHost(t, { inventory: [] });
  const pending = [{ kind: "plugin", spec: "v1-plugin" }];
  host.backing.files.set("plugin-updates.pending", JSON.stringify(pending));
  host.backing.files.set("plugin-updates.lastCheck", JSON.stringify(Date.now()));
  host.backing.files.set(
    "plugin-updates.available",
    JSON.stringify({ candidates: [{ spec: "v1-plugin", status: "checked", updateAvailable: true }], skipped: [] }),
  );

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(host.storageKeys, ["plugin-updates.v2", "plugin-updates.v2.pending-tools"]);
  assert.deepEqual(JSON.parse(host.backing.files.get("plugin-updates.pending") as string), pending);
  assert.equal(setup.model.rows().length, 0);
  assert.equal(setup.model.updateCount(), 0);
  assert.equal(host.toasts.length, 0);
  assert.equal(host.backing.files.size, 4); // nothing deleted, one new snapshot
  const stored = JSON.parse(host.backing.files.get("plugin-updates.v2") as string) as { version: number; environment: string };
  assert.equal(stored.version, 2);
  assert.equal(stored.environment, "/connected/project");
});

test("cleanup releases the route and slot and cancels an in-flight cycle without writing storage", async (t) => {
  const gate = deferred<{ data: unknown[] }>();
  const host = createHost(t, { inventory: [packageInfo("example", { version: "1.0.0" })] });
  host.setList(() => gate.promise);

  const setup = host.setup();
  assert.notEqual(setup.page(), undefined);
  assert.notEqual(setup.slot(), undefined);
  await flush();
  assert.equal(host.requests.list.length, 1);
  const signal = host.requests.list[0]?.signal;

  setup.cleanup();
  assert.equal(signal?.aborted, true);
  assert.equal(setup.page(), undefined);
  assert.equal(setup.slot(), undefined);

  gate.resolve({ data: [packageInfo("example", { version: "1.0.0" })] });
  await flush();
  assert.equal(setup.model.checking(), true); // the disposed model never receives the late result
  assert.equal(setup.model.rows().length, 0);
  assert.equal(host.backing.files.size, 0);
});

test("Space and A select only updatable rows", async (t) => {
  const inventory = [
    packageInfo("stale", { version: "1.0.0" }),
    packageInfo("fresh", { version: "2.0.0" }),
    packageInfo("pinned@1.0.0", { version: "1.0.0" }),
    sdkInfo("sdk-one"),
  ];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true }), ...inventory.slice(1)];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));
  host.registry.set("fresh", () => ({ version: "2.0.0" }));

  const setup = host.setup();
  await setup.model.start();
  assert.deepEqual(
    setup.model.rows().map((row) => row.status),
    ["update", "current", "pinned", "skipped"],
  );

  commandByBind(setup, "a").run();
  assert.deepEqual([...setup.apply.selected()], ["package:stale"]);
  setup.apply.clearSelection();

  // Space never marks pinned or skipped rows.
  commandByBind(setup, "down").run();
  commandByBind(setup, "down").run();
  commandByBind(setup, "space").run();
  assert.equal(setup.apply.selected().size, 0);
  commandByBind(setup, "down").run();
  commandByBind(setup, "space").run();
  assert.equal(setup.apply.selected().size, 0);

  // Space toggles the updatable row under the cursor.
  commandByBind(setup, "up").run();
  commandByBind(setup, "up").run();
  commandByBind(setup, "up").run();
  commandByBind(setup, "space").run();
  assert.deepEqual([...setup.apply.selected()], ["package:stale"]);
  commandByBind(setup, "space").run();
  assert.equal(setup.apply.selected().size, 0);
});

test("U lists the selection with a live-server warning, and cancel sends nothing", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  await commandByBind(setup, "u").run();

  assert.equal(host.confirms.length, 1);
  const dialog = host.confirms[0];
  assert.equal(dialog.title, "Update plugins");
  assert.match(dialog.message, /· stale 1\.0\.0 → 1\.1\.0/);
  assert.match(dialog.message, /live/);
  assert.deepEqual(dialog.label, { confirm: "Update", cancel: "Cancel" });
  // The default fake answer is cancel: no update may leave the screen.
  assert.deepEqual(host.requests.update, []);
  assert.deepEqual([...setup.apply.selected()], ["package:stale"]);
});

test("confirming sends each target once and shows the version actually installed", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const installed = [packageInfo("stale", { version: "1.2.5" })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  // The server resolves and installs a newer version than the snapshot promised.
  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setUpdate(() => {
    applied = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update.map((call) => call.targets), [["stale"]]);
  assert.deepEqual(host.requests.update.map((call) => call.location), [{ directory: "/connected/project" }]);
  const row = rowsBySpec(setup).get("stale");
  assert.equal(row?.installedVersion, "1.2.5"); // the actual result, not the promised 1.1.0
  assert.equal(row?.status, "current");
  const result = setup.apply.result("package:stale");
  assert.equal(result?.phase, "updated");
  assert.equal(result?.unverified, undefined);
  assert.equal(setup.apply.running(), false);
  assert.equal(setup.apply.selected().size, 0);
});

test("a failed target does not stop the others", async (t) => {
  const inventory = [packageInfo("a-pkg", { version: "1.0.0" }), packageInfo("b-pkg", { version: "1.0.0" })];
  const checked = [
    packageInfo("a-pkg", { version: "1.0.0", outdated: true }),
    packageInfo("b-pkg", { version: "1.0.0", outdated: true }),
  ];
  const host = createHost(t, { inventory, checked });
  host.registry.set("a-pkg", () => ({ version: "1.1.0" }));
  host.registry.set("b-pkg", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const installed = [packageInfo("a-pkg", { version: "1.0.0" }), packageInfo("b-pkg", { version: "1.1.0" })];
  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setUpdate((target) => {
    if (target === "a-pkg") throw Error("install failed");
    applied = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update.map((call) => call.targets), [["a-pkg"], ["b-pkg"]]);
  const failed = setup.apply.result("package:a-pkg");
  assert.equal(failed?.phase, "failed");
  assert.match(failed?.message ?? "", /install failed/);
  assert.equal(setup.apply.result("package:b-pkg")?.phase, "updated");
});

test("targets that left the inventory are not updated", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  host.setList(async () => ({ data: [] }));
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update, []);
  assert.equal(setup.apply.result("package:stale")?.phase, "missing");
  // The pre-send verification read the inventory; nothing was applied, so no re-read ran.
  assert.equal(host.requests.list.length, 2);
});

test("a repeat U while an operation runs sends nothing twice", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const gate = deferred<void>();
  const installed = [packageInfo("stale", { version: "1.1.0" })];
  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setUpdate(() => {
    applied = true;
    return gate.promise.then(() => undefined);
  });
  host.setConfirm(() => true);
  const first = commandByBind(setup, "u").run() as Promise<void>;
  await flush();
  assert.equal(host.requests.update.length, 1);
  assert.equal(setup.apply.result("package:stale")?.phase, "updating");
  assert.equal(setup.apply.running(), true);

  // A second press opens no second confirmation while the operation runs.
  commandByBind(setup, "u").run();
  await flush();
  assert.equal(host.confirms.length, 1);
  // The model itself joins the running operation instead of re-sending.
  const joined = setup.apply.execute(setup.model.rows().slice(0, 1));
  await flush();
  assert.equal(host.requests.update.length, 1);

  gate.resolve();
  await Promise.all([first, joined]);
  assert.equal(setup.apply.result("package:stale")?.phase, "updated");
  assert.deepEqual(host.requests.update.map((call) => call.targets), [["stale"]]);
});

test("an in-flight row cannot be toggled while its update runs", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const gate = deferred<void>();
  const installed = [packageInfo("stale", { version: "1.1.0" })];
  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setUpdate(() => {
    applied = true;
    return gate.promise.then(() => undefined);
  });
  host.setConfirm(() => true);
  const running = commandByBind(setup, "u").run() as Promise<void>;
  await flush();
  const row = setup.model.rows()[0];
  setup.apply.toggle(row as ServerRow); // would unmark if the row were still selectable
  assert.deepEqual([...setup.apply.selected()], ["package:stale"]);

  gate.resolve();
  await running;
});

test("a successful load with failed activation is not reported as a clean success", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const broken = [
    { ...packageInfo("stale", { version: "1.2.5" }), state: { status: "failed", error: "activation boom" } },
  ];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  let applied = false;
  host.setList(async () => ({ data: applied ? broken : inventory }));
  host.setCheck(async () => ({ data: applied ? broken : checked }));
  host.setUpdate(() => {
    applied = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  // The install call itself succeeded; the failed activation stays visible on the row.
  assert.equal(setup.apply.result("package:stale")?.phase, "updated");
  const row = rowsBySpec(setup).get("stale");
  assert.equal(row?.failed, "activation boom");
});

test("a target that vanishes from the fresh inventory stays unverified", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  let applied = false;
  host.setList(async () => ({ data: applied ? [] : inventory }));
  host.setCheck(async () => ({ data: applied ? [] : checked }));
  host.setUpdate(() => {
    applied = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update.map((call) => call.targets), [["stale"]]);
  // The install call succeeded, but no fresh inventory row backs it.
  assert.equal(setup.apply.result("package:stale")?.unverified, true);
});

test("a failed re-read leaves an applied update unverified", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  let offline = false;
  host.setList(async () => {
    if (offline) throw Error("server offline");
    return { data: checked };
  });
  host.setUpdate(() => {
    offline = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update.map((call) => call.targets), [["stale"]]);
  const result = setup.apply.result("package:stale");
  assert.equal(result?.phase, "updated");
  assert.equal(result?.unverified, true);
  // The stale row keeps its old version; no fresh one is claimed.
  assert.equal(rowsBySpec(setup).get("stale")?.installedVersion, "1.0.0");
});

test("the update flow leaves V1 pending state untouched", async (t) => {
  const inventory = [packageInfo("stale", { version: "1.0.0" })];
  const checked = [packageInfo("stale", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.registry.set("stale", () => ({ version: "1.1.0" }));
  const pending = [{ kind: "plugin", spec: "v1-plugin" }];
  host.backing.files.set("plugin-updates.pending", JSON.stringify(pending));
  host.backing.files.set("plugin-updates.lastCheck", "42");

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();
  const installed = [packageInfo("stale", { version: "1.1.0" })];
  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setUpdate(() => {
    applied = true;
    return Promise.resolve();
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.requests.update.map((call) => call.targets), [["stale"]]);
  assert.deepEqual(JSON.parse(host.backing.files.get("plugin-updates.pending") as string), pending);
  assert.equal(host.backing.files.get("plugin-updates.lastCheck"), "42");
  assert.deepEqual(host.storageKeys, ["plugin-updates.v2", "plugin-updates.v2.pending-tools"]);
});

test("cleanup aborts an in-flight update and never sends the rest", async (t) => {
  const inventory = [packageInfo("a-pkg", { version: "1.0.0" }), packageInfo("b-pkg", { version: "1.0.0" })];
  const checked = [
    packageInfo("a-pkg", { version: "1.0.0", outdated: true }),
    packageInfo("b-pkg", { version: "1.0.0", outdated: true }),
  ];
  const host = createHost(t, { inventory, checked });
  host.registry.set("a-pkg", () => ({ version: "1.1.0" }));
  host.registry.set("b-pkg", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const gate = deferred<void>();
  host.setUpdate(() => gate.promise.then(() => undefined));
  host.setConfirm(() => true);
  const running = commandByBind(setup, "u").run() as Promise<void>;
  await flush();
  assert.deepEqual(host.requests.update.map((call) => call.targets), [["a-pkg"]]);
  const signal = host.requests.update[0]?.signal;

  host.backing.files.set("plugin-updates.pending", JSON.stringify([{ kind: "plugin", spec: "v1" }]));
  setup.cleanup();
  assert.equal(signal?.aborted, true);

  gate.resolve();
  await flush();
  assert.deepEqual(host.requests.update.map((call) => call.targets), [["a-pkg"]]); // b-pkg is never sent
  assert.equal(
    host.backing.files.get("plugin-updates.pending"),
    JSON.stringify([{ kind: "plugin", spec: "v1" }]),
  );
});

test("TUI rows join the cycle: shared pair, cli-only row, one fetch per name, one toast per target", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const inventory = [packageInfo("shared", { version: "1.0.0", tui: true })];
  const checked = [packageInfo("shared", { version: "1.0.0", outdated: true, tui: true })];
  const host = createHost(t, { inventory, checked });
  host.tui.targets = ["shared", "tui-only"];
  host.tui.versions.set("shared", "1.0.0");
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("shared", () => ({ version: "1.1.0" }));
  host.registry.set("tui-only", () => ({ version: "1.2.0" }));

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(
    setup.model.rows().map((row) => [row.runtime, row.spec, row.status]),
    [
      ["server", "shared", "update"],
      ["tui", "shared", "update"],
      ["tui", "tui-only", "update"],
    ],
  );
  // The shared pair is one update unit: the toast counts targets, not rows.
  assert.equal(setup.model.updateCount(), 2);
  assert.deepEqual(host.toasts, [{ message: "2 OpenCode updates available. Run /plugin-updates to review them." }]);
  assert.deepEqual(host.fetches.map((fetch) => fetch.name), ["shared", "tui-only"]);
  const serverRow = rowById(setup, "package:shared");
  assert.equal(serverRow?.shared, true);
  assert.equal(serverRow?.twin, "tui:shared");
  const tuiRow = rowById(setup, "tui:shared");
  assert.equal(tuiRow?.shared, true);
  assert.equal(tuiRow?.twin, "package:shared");
  assert.equal(tuiRow?.installedVersion, "1.0.0");

  // A new cli.json target is never hidden behind a fresh TTL.
  t.mock.timers.setTime(START + HOUR);
  host.tui.targets = ["shared", "tui-only", "added"];
  host.tui.versions.set("added", "1.0.0");
  host.registry.set("added", () => ({ version: "9.0.0" }));
  const second = host.setup();
  await second.model.start();
  assert.equal(host.requests.check.length, 2); // the cycle repeated despite the fresh clock
  assert.equal(rowsBySpec(second).get("added")?.status, "update");
  assert.equal(host.toasts.length, 2); // each cycle with updates toasts once on its own instance
});

test("the effective TUI inventory omits targets the TUI cannot load", async (t) => {
  const inventory = [
    packageInfo("server-only", { version: "1.0.0" }),
    packageInfo("exposed", { version: "1.0.0", tui: true }),
  ];
  const host = createHost(t, { inventory, checked: inventory });
  host.tui.targets = ["server-only", "exposed", "not-installed", "hidden-entry", "/local/plugin", "pinned@2.0.0"];
  host.tui.versions.set("server-only", "1.0.0");
  host.tui.versions.set("exposed", "1.0.0");
  host.tui.versions.set("hidden-entry", "1.0.0");
  host.tui.versions.set("pinned@2.0.0", "2.0.0");
  host.tui.exposed.set("hidden-entry", false);
  host.registry.set("server-only", () => ({ version: "1.0.0" }));
  host.registry.set("exposed", () => ({ version: "1.0.0" }));

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(
    setup.model.rows().map((row) => [row.runtime, row.spec, row.status]),
    [
      ["server", "server-only", "current"],
      ["server", "exposed", "current"],
      ["tui", "exposed", "current"],
      ["tui", "/local/plugin", "skipped"],
      ["tui", "pinned@2.0.0", "pinned"],
    ],
  );
  const skipped = setup.model.rows().find((row) => row.spec === "/local/plugin");
  assert.equal(skipped?.reason, "local path");
  const pinned = setup.model.rows().find((row) => row.spec === "pinned@2.0.0");
  assert.equal(pinned?.pinnedVersion, "2.0.0");
  commandByBind(setup, "a").run();
  assert.equal(setup.apply.selected().size, 0); // skipped and pinned rows never enter the selection
});

test("the screen lists one line per plugin: a shared pair collapses to its server copy, local paths never list", async (t) => {
  const inventory = [
    packageInfo("exposed", { version: "1.0.0", tui: true }),
    packageInfo("server-only", { version: "1.0.0" }),
    localInfo("./plugins/notify"),
  ];
  const host = createHost(t, { inventory, checked: inventory });
  host.tui.targets = ["exposed", "tui-only", "/local/plugin"];
  host.tui.versions.set("exposed", "1.0.0");
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("exposed", () => ({ version: "1.0.0" }));
  host.registry.set("server-only", () => ({ version: "1.0.0" }));
  host.registry.set("tui-only", () => ({ version: "1.0.0" }));

  const setup = host.setup();
  await setup.model.start();

  // The model keeps both halves of a pair and the local rows: selection and
  // the settle poll still walk them.
  assert.deepEqual(setup.model.rows().map((row) => row.id), [
    "package:exposed",
    "package:server-only",
    "local:./plugins/notify",
    "tui:exposed",
    "tui:tui-only",
    "tui:/local/plugin",
  ]);
  assert.deepEqual(
    listedRows(setup.model.rows()).map((row) => row.id),
    ["package:exposed", "package:server-only", "tui:tui-only"],
  );
});

test("the apply summary counts plugins, not runtimes: a shared pair is one update unit", () => {
  const results = new Map<string, ApplyResult>([
    ["package:shared", { phase: "updated" }],
    ["tui:shared", { phase: "updated" }],
    ["package:server-only", { phase: "updated" }],
    ["tui:tui-only", { phase: "failed", message: "update failed" }],
  ]);
  const summary = summarizeApply(results);
  assert.equal(summary.updated, 2); // the shared pair plus the server-only plugin
  assert.equal(summary.failed, 1);
  assert.equal(summary.missing, 0);
});

test("a twin's weaker verdict never doubles a target: halves collapse into one outcome", () => {
  // The unclaimed TUI half rides the same generation: absorbed by the server half's update.
  assert.deepEqual(
    summarizeApply(
      new Map<string, ApplyResult>([
        ["package:shared", { phase: "updated" }],
        ["tui:shared", { phase: "missing", message: "the host did not confirm an update" }],
      ]),
    ),
    { updated: 1, unverified: 0, unchanged: 0, failed: 0, missing: 0 },
  );
  // Both halves failed together: one CLI run, one failure.
  assert.deepEqual(
    summarizeApply(
      new Map<string, ApplyResult>([
        ["package:shared", { phase: "failed", message: "update failed" }],
        ["tui:shared", { phase: "failed", message: "update failed" }],
      ]),
    ),
    { updated: 0, unverified: 0, unchanged: 0, failed: 1, missing: 0 },
  );
  // An unreadable re-read leaves one unverified plugin, not two.
  assert.deepEqual(
    summarizeApply(
      new Map<string, ApplyResult>([
        ["package:shared", { phase: "updated", unverified: true }],
        ["tui:shared", { phase: "updated", unverified: true }],
      ]),
    ),
    { updated: 0, unverified: 1, unchanged: 0, failed: 0, missing: 0 },
  );
  // A claimed-but-unmoved half absorbs its unconfirmed twin as one unchanged plugin.
  assert.deepEqual(
    summarizeApply(
      new Map<string, ApplyResult>([
        ["package:shared", { phase: "updated", unchanged: true }],
        ["tui:shared", { phase: "missing", message: "the host did not confirm an update" }],
      ]),
    ),
    { updated: 0, unverified: 0, unchanged: 1, failed: 0, missing: 0 },
  );
  // One failed half never hides behind an updated twin.
  assert.deepEqual(
    summarizeApply(
      new Map<string, ApplyResult>([
        ["package:shared", { phase: "updated" }],
        ["tui:shared", { phase: "failed", message: "update failed" }],
      ]),
    ),
    { updated: 1, unverified: 0, unchanged: 0, failed: 1, missing: 0 },
  );
});

test("a shared twin whose cache is already ahead stays current while the server row updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const inventory = [packageInfo("shared", { version: "1.0.0", tui: true })];
  const checked = [packageInfo("shared", { version: "1.0.0", outdated: true, tui: true })];
  const host = createHost(t, { inventory, checked });
  host.tui.targets = ["shared"];
  host.tui.versions.set("shared", "1.1.0"); // the generation is installed; the server has not re-activated
  host.registry.set("shared", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  assert.deepEqual(
    setup.model.rows().map((row) => [row.runtime, row.spec, row.status]),
    [
      ["server", "shared", "update"],
      ["tui", "shared", "current"],
    ],
  );

  // Selecting the updatable row still selects the joint group.
  commandByBind(setup, "a").run();
  assert.deepEqual([...setup.apply.selected()].sort(), ["package:shared", "tui:shared"]);
  host.setConfirm(() => true);
  let serverApiTouched = false;
  host.setCli((target) => {
    assert.equal(target, "shared");
    return { code: 0, stdout: 'Updated Server plugin "x"\n', stderr: "" };
  });
  host.setUpdate(() => {
    serverApiTouched = true;
    return Promise.resolve();
  });
  const installed = [packageInfo("shared", { version: "1.2.5", tui: true })];
  host.setList(async () => ({ data: installed }));
  host.setCheck(async () => ({ data: installed }));
  await driveClock(t, () => commandByBind(setup, "u").run() as Promise<void>);
  assert.deepEqual(host.cliCalls.map((call) => call.target), ["shared"]);
  assert.deepEqual(host.requests.update, []);
  assert.equal(serverApiTouched, false); // a shared target must not go through the server API
  // The server runtime moved; the cache-ahead half had nothing left to apply.
  assert.equal(setup.apply.result("package:shared")?.phase, "updated");
  const tuiResult = setup.apply.result("tui:shared");
  assert.equal(tuiResult?.phase, "missing");
  assert.match(tuiResult?.message ?? "", /did not confirm/);
});

test("Space selects the whole shared group, the confirmation lists the plugin once, and cancel sends nothing", async (t) => {
  const inventory = [packageInfo("shared", { version: "1.0.0", tui: true })];
  const checked = [packageInfo("shared", { version: "1.0.0", outdated: true, tui: true })];
  const host = createHost(t, { inventory, checked });
  host.tui.targets = ["shared"];
  host.tui.versions.set("shared", "1.0.0");
  host.registry.set("shared", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  const serverRow = rowById(setup, "package:shared") as ServerRow;
  setup.apply.toggle(serverRow);
  assert.deepEqual([...setup.apply.selected()].sort(), ["package:shared", "tui:shared"]);

  await commandByBind(setup, "u").run();
  assert.equal(host.confirms.length, 1);
  const dialog = host.confirms[0];
  assert.match(dialog.message, /· shared 1\.0\.0 → 1\.1\.0/);
  assert.equal(dialog.message.match(/· shared/g)?.length, 1); // one line per plugin, not one per runtime
  assert.match(dialog.message, /applies these updates live/);
  assert.match(dialog.message, /until it restarts/);
  assert.match(dialog.message, /either or both runtimes/);
  assert.deepEqual(host.cliCalls, []);
  assert.deepEqual(host.requests.update, []);
  assert.deepEqual([...setup.apply.selected()].sort(), ["package:shared", "tui:shared"]);
});

test("a shared target runs one CLI call and both rows re-read their own runtime", async (t) => {
  const inventory = [packageInfo("shared", { version: "1.0.0", tui: true })];
  const checked = [packageInfo("shared", { version: "1.0.0", outdated: true, tui: true })];
  const installed = [packageInfo("shared", { version: "1.2.5", tui: true })];
  const host = createHost(t, { inventory, checked });
  host.tui.targets = ["shared"];
  host.tui.versions.set("shared", "1.0.0");
  host.registry.set("shared", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  let applied = false;
  host.setList(async () => ({ data: applied ? installed : inventory }));
  host.setCheck(async () => ({ data: applied ? installed : checked }));
  host.setCli(() => {
    applied = true;
    host.tui.versions.set("shared", "1.2.5");
    return { code: 0, stdout: 'Updated Server plugin "x"\n', stderr: "" };
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.cliCalls.map((call) => call.target), ["shared"]);
  assert.deepEqual(host.cliCalls.map((call) => call.cwd), ["/connected/project"]);
  assert.deepEqual(host.requests.update, []); // no second server API update for the same target
  const serverRow = rowById(setup, "package:shared");
  assert.equal(serverRow?.installedVersion, "1.2.5");
  assert.equal(serverRow?.status, "current");
  const tuiRow = rowById(setup, "tui:shared");
  assert.equal(tuiRow?.installedVersion, "1.2.5");
  assert.equal(setup.apply.result("package:shared")?.phase, "updated");
  assert.equal(setup.apply.result("tui:shared")?.phase, "updated");
  assert.equal(setup.apply.result("package:shared")?.unchanged, undefined);
  assert.equal(setup.apply.selected().size, 0);
});

test("a TUI-only target updates through the CLI alone and leaves the server untouched", async (t) => {
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  assert.equal(rowsBySpec(setup).get("tui-only")?.status, "update");
  commandByBind(setup, "a").run();

  host.setCli((target) => {
    assert.equal(target, "tui-only");
    host.tui.versions.set("tui-only", "1.1.0");
    return { code: 0, stdout: 'Updated TUI plugin "tui-only"\n', stderr: "" };
  });
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]);
  assert.deepEqual(host.requests.update, []);
  const row = rowsBySpec(setup).get("tui-only");
  assert.equal(row?.installedVersion, "1.1.0");
  assert.equal(row?.status, "current");
  assert.equal(setup.apply.result("tui:tui-only")?.phase, "updated");
});

test("a CLI run that updates nothing reports not updated without a re-read", async (t) => {
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const listsAfterCycle = host.requests.list.length;
  host.setCli(() => ({ code: 0, stdout: "No plugin updates available\n", stderr: "" }));
  host.setConfirm(() => true);
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]);
  const result = setup.apply.result("tui:tui-only");
  assert.equal(result?.phase, "missing");
  assert.match(result?.message ?? "", /did not confirm/);
  // Only the pre-send verification read the inventory; nothing was claimed,
  // so no settle poll ran.
  assert.equal(host.requests.list.length, listsAfterCycle + 1);
});

test("a claimed update the inventory does not back is reported as unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  host.setCli(() => ({ code: 0, stdout: 'Updated TUI plugin "tui-only"\n', stderr: "" }));
  host.setConfirm(() => true);
  await driveClock(t, () => commandByBind(setup, "u").run() as Promise<void>);

  const result = setup.apply.result("tui:tui-only");
  assert.equal(result?.phase, "updated");
  assert.equal(result?.unchanged, true); // the installed generation did not move
  assert.equal(rowsBySpec(setup).get("tui-only")?.installedVersion, "1.0.0");
});

test("a CLI failure is isolated to its own rows and a repeat press joins the running operation", async (t) => {
  const inventory = [packageInfo("a-pkg", { version: "1.0.0" })];
  const checked = [packageInfo("a-pkg", { version: "1.0.0", outdated: true })];
  const host = createHost(t, { inventory, checked });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("a-pkg", () => ({ version: "1.1.0" }));
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const gate = deferred<void>();
  host.setCli((_target, _cwd, signal) => {
    if (signal?.aborted) return { code: 1, stdout: "", stderr: "" };
    return gate.promise.then(() => ({ code: 1, stdout: "", stderr: 'Failed to update TUI plugin "tui-only": boom\n' }));
  });
  host.setUpdate(() => Promise.reject(Error("install failed")));
  host.setConfirm(() => true);
  const first = commandByBind(setup, "u").run() as Promise<void>;
  await flush();
  assert.equal(host.cliCalls.length, 1);

  // A second press opens no second confirmation and joins the operation.
  commandByBind(setup, "u").run();
  const joined = setup.apply.execute(setup.model.rows().filter((row) => row.status === "update"));
  await flush();
  assert.equal(host.cliCalls.length, 1);
  assert.equal(host.requests.update.length, 1);

  gate.resolve();
  await Promise.all([first, joined]);
  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]);
  const failed = setup.apply.result("tui:tui-only");
  assert.equal(failed?.phase, "failed");
  assert.match(failed?.message ?? "", /boom/);
  assert.equal(setup.apply.result("package:a-pkg")?.phase, "failed");
  assert.match(setup.apply.result("package:a-pkg")?.message ?? "", /install failed/);
});

test("membership changes between selection and send block the group without updating either runtime", async (t) => {
  // A cli.json-only target that leaves the TUI inventory is blocked.
  const removed = createHost(t, { inventory: [] });
  removed.tui.targets = ["tui-only"];
  removed.tui.versions.set("tui-only", "1.0.0");
  removed.registry.set("tui-only", () => ({ version: "1.1.0" }));
  const removedSetup = removed.setup();
  await removedSetup.model.start();
  commandByBind(removedSetup, "a").run();
  removed.setConfirm(() => true);
  removed.tui.targets = [];
  await commandByBind(removedSetup, "u").run();
  assert.deepEqual(removed.cliCalls, []);
  assert.deepEqual(removed.requests.update, []);
  assert.equal(removedSetup.apply.result("tui:tui-only")?.phase, "missing");
  assert.match(removedSetup.apply.result("tui:tui-only")?.message ?? "", /inventory changed/);

  // A shared target whose server row disappears blocks both rows as a group.
  const shared = createHost(t, {
    inventory: [packageInfo("shared", { version: "1.0.0", tui: true })],
    checked: [packageInfo("shared", { version: "1.0.0", outdated: true, tui: true })],
  });
  shared.tui.targets = ["shared"];
  shared.tui.versions.set("shared", "1.0.0");
  shared.registry.set("shared", () => ({ version: "1.1.0" }));
  const sharedSetup = shared.setup();
  await sharedSetup.model.start();
  commandByBind(sharedSetup, "a").run();
  shared.setConfirm(() => true);
  shared.setList(async () => ({ data: [] }));
  shared.setCheck(async () => ({ data: [] }));
  await commandByBind(sharedSetup, "u").run();
  assert.deepEqual(shared.cliCalls, []);
  assert.deepEqual(shared.requests.update, []);
  assert.equal(sharedSetup.apply.result("package:shared")?.phase, "missing");
  assert.equal(sharedSetup.apply.result("tui:shared")?.phase, "missing");

  // A server-only selection that gained a TUI half is blocked the same way.
  const solo = createHost(t, { inventory: [packageInfo("solo", { version: "1.0.0" })] });
  solo.setCheck(async () => ({ data: [packageInfo("solo", { version: "1.0.0", outdated: true })] }));
  solo.registry.set("solo", () => ({ version: "1.1.0" }));
  const soloSetup = solo.setup();
  await soloSetup.model.start();
  commandByBind(soloSetup, "a").run();
  solo.setConfirm(() => true);
  solo.tui.targets = ["solo"];
  solo.tui.versions.set("solo", "1.0.0");
  await commandByBind(soloSetup, "u").run();
  assert.deepEqual(solo.cliCalls, []);
  assert.deepEqual(solo.requests.update, []);
  assert.equal(soloSetup.apply.result("package:solo")?.phase, "missing");
});

test("a reload after a completed TUI update neither re-sends nor toasts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(host.toasts.length, 1);
  commandByBind(first, "a").run();
  host.setCli(() => {
    host.tui.versions.set("tui-only", "1.1.0");
    return { code: 0, stdout: 'Updated TUI plugin "tui-only"\n', stderr: "" };
  });
  host.setConfirm(() => true);
  await commandByBind(first, "u").run();
  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]);

  // The plugin generation reloads (or the TUI restarts): a fresh setup sees
  // the updated version, runs no update, and stays silent.
  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]);
  assert.deepEqual(host.requests.update, []);
  assert.equal(host.toasts.length, 1);
  assert.equal(rowsBySpec(second).get("tui-only")?.status, "current");
});

test("a send after the connection moved to another location is blocked without updating anything", async (t) => {
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  assert.equal(setup.model.checkedEnvironment(), "/connected/project");
  commandByBind(setup, "a").run();
  host.setConfirm(() => true);

  host.setLocation("/project/other");
  await commandByBind(setup, "u").run();

  assert.deepEqual(host.cliCalls, []);
  assert.deepEqual(host.requests.update, []);
  const result = setup.apply.result("tui:tui-only");
  assert.equal(result?.phase, "missing");
  assert.match(result?.message ?? "", /location changed/);
  // Like every executed send, the attempt consumes the selection; the rows
  // are stale for the new connection until the next check anyway.
  assert.equal(setup.apply.selected().size, 0);
});

test("a claimed update whose fresh row carries no version stays unverified, not unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  const unversioned = [{ source: { type: "package", target: "tui-only" }, state: { status: "active" } }];
  let applied = false;
  host.setList(async () => ({ data: applied ? unversioned : [] }));
  host.setCheck(async () => ({ data: applied ? unversioned : [] }));
  host.setCli(() => {
    applied = true;
    return { code: 0, stdout: 'Updated TUI plugin "tui-only"\n', stderr: "" };
  });
  host.setConfirm(() => true);
  await driveClock(t, () => commandByBind(setup, "u").run() as Promise<void>);

  const result = setup.apply.result("tui:tui-only");
  assert.equal(result?.phase, "updated");
  assert.equal(result?.unchanged, undefined);
  assert.equal(result?.unverified, true); // no version was ever observed for the fresh row
});

test("cleanup aborts a running CLI operation and sends nothing further", async (t) => {
  const host = createHost(t, { inventory: [] });
  host.tui.targets = ["tui-only"];
  host.tui.versions.set("tui-only", "1.0.0");
  host.registry.set("tui-only", () => ({ version: "1.1.0" }));

  const setup = host.setup();
  await setup.model.start();
  commandByBind(setup, "a").run();

  host.setCli((_target, _cwd, signal) => {
    return new Promise<CliUpdateResult>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  host.setConfirm(() => true);
  const running = commandByBind(setup, "u").run() as Promise<void>;
  await flush();
  assert.equal(host.cliCalls.length, 1);
  const signal = host.cliCalls[0]?.signal;

  setup.cleanup();
  assert.equal(signal?.aborted, true);
  await flush();
  assert.deepEqual(host.cliCalls.map((call) => call.target), ["tui-only"]); // no retry, no second call
});

test("installed formatters join the count and toast; only one with a confirmed update is selectable", async (t) => {
  const host = createHost(t, { inventory: [] });
  const manifest = installGeneration(host.cacheDir, "prettier", "1", "3.0.0");
  installGeneration(host.cacheDir, "prettier", "2", "3.1.0");
  installGeneration(host.cacheDir, "@biomejs/biome", "7", "2.0.0");
  host.registry.set("prettier", () => ({ version: "3.2.0" }));
  host.registry.set("@biomejs/biome", () => ({ version: "2.0.0" }));

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(
    setup.model.rows().map((row) => [row.id, row.runtime, row.spec, row.installedVersion, row.latestVersion, row.status]),
    [
      ["tool:prettier", "tool", "prettier", "3.1.0", "3.2.0", "update"],
      ["tool:@biomejs/biome", "tool", "@biomejs/biome", "2.0.0", "2.0.0", "current"],
    ],
  );
  assert.equal(setup.model.updateCount(), 1); // the formatter update joins the shared count
  assert.deepEqual(host.toasts, [{ message: "1 OpenCode updates available. Run /plugin-updates to review them." }]);
  assert.deepEqual(host.fetches.map((fetch) => fetch.name), ["prettier", "@biomejs/biome"]);
  assert.equal(host.requests.info.length, 1); // the locality verdict was verified once
  assert.equal(host.requests.check.length, 0); // no plugin targets: no host check
  assert.deepEqual(setup.model.toolsAvailability(), { available: true });

  // A managed tool with a confirmed update is selectable; a current one is not.
  // U is the plugin action and never updates a tool.
  commandByBind(setup, "a").run(); // select all updatable → prettier only
  assert.deepEqual([...setup.apply.selected()], ["tool:prettier"]);
  commandByBind(setup, "down").run();
  commandByBind(setup, "space").run(); // @biomejs/biome is current — not updatable
  assert.deepEqual([...setup.apply.selected()], ["tool:prettier"]);
  await commandByBind(setup, "u").run();
  assert.deepEqual(host.confirms, []);
  assert.deepEqual(host.requests.update, []);

  // The read-only adapter left the cache bytes untouched through cleanup.
  const before = readFileSync(manifest, "utf8");
  setup.cleanup();
  await flush();
  assert.equal(readFileSync(manifest, "utf8"), before);
});

test("a formatter with an unreadable manifest or a failed registry lookup stays unknown without breaking the cycle", async (t) => {
  const host = createHost(t, { inventory: [] });
  installGeneration(host.cacheDir, "oxfmt", "1", null);
  installGeneration(host.cacheDir, "@biomejs/biome", "1", "1.0.0");
  host.registry.set("oxfmt", () => ({ version: "1.1.0" }));
  host.registry.set("@biomejs/biome", () => {
    throw Error("registry offline");
  });

  const setup = host.setup();
  await setup.model.start();

  const rows = rowsBySpec(setup);
  assert.equal(rows.get("oxfmt")?.status, "unknown");
  assert.equal(rows.get("oxfmt")?.installedVersion, undefined);
  assert.equal(rows.get("oxfmt")?.reason, "installed version unavailable");
  assert.equal(rows.get("@biomejs/biome")?.status, "unknown");
  assert.equal(rows.get("@biomejs/biome")?.reason, "registry lookup failed");
  assert.equal(setup.model.freshness(), "fresh"); // one isolated failure does not discard the cycle
  assert.deepEqual(host.toasts, []);
});

test("a missing cache leaves an empty managed tools section", async (t) => {
  const host = createHost(t, { inventory: [] });
  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(toolRows(setup), []);
  assert.deepEqual(setup.model.toolsAvailability(), { available: true });
  assert.deepEqual(host.fetches, []); // no formatter, no registry request
});

test("foreign packages and the V1 cache layout contribute no managed tool rows", async (t) => {
  const host = createHost(t, { inventory: [] });
  installGeneration(host.cacheDir, "pyright", "1", "1.0.0"); // a managed LSP server, not a formatter
  const v1Tool = join(host.cacheDir, "packages", "prettier", "node_modules", "prettier");
  mkdirSync(v1Tool, { recursive: true });
  writeFileSync(join(v1Tool, "package.json"), JSON.stringify({ name: "prettier", version: "1.0.0" }));
  const v1Plugin = join(host.cacheDir, "packages", "prettier@latest", "3", "node_modules", "prettier");
  mkdirSync(v1Plugin, { recursive: true });
  writeFileSync(join(v1Plugin, "package.json"), JSON.stringify({ name: "prettier", version: "2.0.0" }));

  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(toolRows(setup), []);
  assert.deepEqual(setup.model.toolsAvailability(), { available: true });
  assert.deepEqual(host.fetches, []);
});

test("a server that is not verifiably local keeps the managed tools section unavailable and reads no local cache", async (t) => {
  const host = createHost(t, { inventory: [] });
  installGeneration(host.cacheDir, "prettier", "1", "3.0.0");
  host.registry.set("prettier", () => ({ version: "3.1.0" }));

  host.setServerInfo(() => ({ version: "2.0.16", pid: process.pid, urls: [], paths: { tmp: "/remote/tmp/opencode" } }));
  const setup = host.setup();
  await setup.model.start();

  assert.deepEqual(toolRows(setup), []); // the local cache is not read for a remote server
  assert.deepEqual(setup.model.toolsAvailability(), {
    available: false,
    reason: "the connected server is not on this machine",
  });
  assert.deepEqual(host.fetches, []); // not even a registry lookup happened

  // An identity that cannot be read is unavailable as well, never local.
  host.setServerInfo(() => {
    throw Error("offline");
  });
  const second = host.setup();
  await second.model.start();
  assert.deepEqual(second.model.toolsAvailability(), {
    available: false,
    reason: "the server did not report its identity",
  });
  assert.deepEqual(toolRows(second), []);
});

test("a managed tools snapshot survives a restart without repeating the cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, { inventory: [] });
  installGeneration(host.cacheDir, "prettier", "1", "3.0.0");
  host.registry.set("prettier", () => ({ version: "3.1.0" }));

  const first = host.setup();
  await first.model.start();
  assert.equal(host.fetches.length, 1);
  assert.equal(host.toasts.length, 1);

  t.mock.timers.setTime(START + HOUR);
  const second = host.setup();
  await second.model.start();
  assert.equal(host.fetches.length, 1); // the fresh TTL served the stored snapshot
  assert.equal(host.toasts.length, 1);
  assert.equal(rowsBySpec(second).get("prettier")?.status, "update");
  assert.deepEqual(second.model.toolsAvailability(), { available: true });
});

test("a newly installed formatter or a locality flip is never hidden behind a fresh TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const host = createHost(t, { inventory: [] });

  const first = host.setup();
  await first.model.start();
  assert.deepEqual(first.model.toolsAvailability(), { available: true });
  assert.deepEqual(host.fetches, []);

  t.mock.timers.setTime(START + HOUR);
  installGeneration(host.cacheDir, "prettier", "1", "3.0.0");
  host.registry.set("prettier", () => ({ version: "3.1.0" }));
  const second = host.setup();
  await second.model.start();
  assert.equal(host.fetches.length, 1); // the fresh snapshot did not hide the new formatter
  assert.equal(rowsBySpec(second).get("prettier")?.status, "update");

  t.mock.timers.setTime(START + 2 * HOUR);
  host.setServerInfo(() => ({ version: "2.0.16", pid: process.pid, urls: [], paths: { tmp: "/remote/tmp/opencode" } }));
  const third = host.setup();
  await third.model.start();
  assert.equal(host.fetches.length, 1); // the local cache is not read for the remote connection
  assert.deepEqual(third.model.toolsAvailability(), {
    available: false,
    reason: "the connected server is not on this machine",
  });
  assert.deepEqual(toolRows(third), []);
});
