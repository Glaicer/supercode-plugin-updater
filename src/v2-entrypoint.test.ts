import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode/plugin/tui";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opentui/solid") {
      return { url: pathToFileURL(join(root, "src/solid-stub.js")).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

type Model = { status(): string; error(): string; plugins(): unknown[] };
type Rendered = { props: { model: Model; back(): void } };

test("the V2 entrypoint opens server inventory from the connected location and releases its route", async () => {
  const plugin = (await import(pathToFileURL(join(root, "dist/update-checker.js")).href)).default as {
    id: string;
    setup(context: Plugin.Context): void | (() => void);
  };
  assert.equal(plugin.id, "supercode.update-checker");
  let page: { render(input: object): unknown } | undefined;
  let removed = false;
  let slot: { render(): unknown } | undefined;
  let slotRemoved = false;
  const previous = { type: "session", sessionID: "ses_test" };
  const current: Record<string, unknown> = { ...previous };
  const destinations: unknown[] = [];
  const layers: Array<() => { commands?: Array<{ id?: string; run(): void }> }> = [];
  const locations: unknown[] = [];
  let resolveList!: (value: { data: unknown[] }) => void;
  let pending = new Promise<{ data: unknown[] }>((resolve) => { resolveList = resolve; });
  const context = {
    location: { directory: "/connected/project" },
    data: { location: { default: () => { throw Error("should use current location"); } } },
    client: { plugin: { list: ({ location }: { location: unknown }) => {
      locations.push(location);
      return pending;
    } } },
    ui: { slot: (registered: typeof slot) => { slot = registered; return () => { slotRemoved = true; slot = undefined; }; }, router: {
      register: (registered: typeof page) => { page = registered; return () => { removed = true; page = undefined; }; },
      current: () => current,
      navigate: (destination: unknown) => {
        destinations.push({ ...(destination as object) });
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, destination);
        if (current.type === "plugin" && current.name === "plugin-updates") current.id = "supercode.update-checker";
      },
    } },
    keymap: { layer: (layer: typeof layers[number]) => { layers.push(layer); } },
  } as unknown as Plugin.Context;

  const cleanup = plugin.setup(context);
  assert.equal(locations.length, 0);
  assert.equal(layers.length, 0);
  slot?.render();
  assert.equal(layers[0]?.().commands?.[0]?.id, "supercode.plugin-updates.open");
  layers[0]?.().commands?.[0]?.run();
  assert.deepEqual(locations, [{ directory: "/connected/project" }]);
  assert.deepEqual(destinations, [{ type: "plugin", name: "plugin-updates" }]);
  const screen = page?.render({}) as Rendered;
  assert.equal(screen.props.model.status(), "loading");

  resolveList({ data: [{ id: "opencode.example", source: { type: "builtin" }, state: { status: "active" } }] });
  await pending;
  await Promise.resolve();
  assert.equal(screen.props.model.status(), "empty");

  pending = Promise.reject(new Error("server offline"));
  layers[0]?.().commands?.[0]?.run();
  await Promise.resolve();
  assert.equal(screen.props.model.status(), "error");
  assert.equal(screen.props.model.error(), "server offline");

  pending = new Promise((resolve) => { resolveList = resolve; });
  layers[0]?.().commands?.[0]?.run();
  resolveList({ data: [
    { id: "opencode.example", source: { type: "builtin" }, state: { status: "active" } },
    { id: "example", source: { type: "package", target: "example@latest" }, state: { status: "active" } },
  ] });
  await pending;
  await Promise.resolve();
  assert.equal(screen.props.model.status(), "ready");
  assert.equal(screen.props.model.plugins().length, 1);
  screen.props.back();
  assert.deepEqual(destinations.at(-1), previous);

  pending = new Promise((resolve) => { resolveList = resolve; });
  layers[0]?.().commands?.[0]?.run();
  assert.equal(screen.props.model.status(), "loading");

  (cleanup as () => void)();
  resolveList({ data: [] });
  await pending;
  assert.equal(screen.props.model.status(), "loading");
  assert.equal(removed, true);
  assert.equal(slotRemoved, true);
  assert.equal(page, undefined);
});
