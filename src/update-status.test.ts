import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApplyResult, ServerApply } from "./server-apply.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context);
    if (specifier === "@opentui/solid") {
      return { url: pathToFileURL(join(root, "src/solid-stub.js")).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createRoot, createSignal } = await import("solid-js");
const { createApplyStatus } = await import(pathToFileURL(join(root, "dist/update-checker.js")).href) as {
  createApplyStatus(apply: ServerApply): () => string;
};

test("the update status cycles dots while running, stops, and restarts with one dot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const [running, setRunning] = createSignal(false);
  const [results, setResults] = createSignal<ReadonlyMap<string, ApplyResult>>(new Map());
  let dispose = () => {};
  const status = createRoot((stop) => {
    dispose = stop;
    return createApplyStatus({ running, results } as ServerApply);
  });
  t.after(() => dispose());

  assert.equal(status(), "");
  setRunning(true);
  await Promise.resolve();
  assert.equal(status(), "Updating plugins.");
  t.mock.timers.tick(500);
  assert.equal(status(), "Updating plugins..");
  t.mock.timers.tick(500);
  assert.equal(status(), "Updating plugins...");
  t.mock.timers.tick(500);
  assert.equal(status(), "Updating plugins.");

  setRunning(false);
  setResults(new Map([["package:example", { phase: "updated" }]]));
  assert.equal(status(), "Update finished: 1 updated · 0 failed · 0 not updated.");
  t.mock.timers.tick(2000);
  setRunning(true);
  assert.equal(status(), "Updating plugins.");
  t.mock.timers.tick(500);
  assert.equal(status(), "Updating plugins..");

  dispose();
  t.mock.timers.tick(500);
  assert.equal(status(), "Updating plugins..");
});
