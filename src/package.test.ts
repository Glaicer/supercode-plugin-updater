import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DIST_FILES = [
  "checker.js",
  "durable-state.js",
  "plugins.js",
  "server-inventory.js",
  "server-updates.js",
  "update-checker.js",
];

test("the published TUI entrypoint is precompiled with Solid reactivity", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports?: { "./tui"?: unknown };
    files?: unknown;
  };
  const compiled = await readFile(join(root, "dist", "update-checker.js"), "utf8");

  assert.equal(packageJson.exports?.["./tui"], "./dist/update-checker.js");
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.match(compiled, /get each\(\)/);
  assert.match(compiled, /_\$effect/);
  assert.doesNotMatch(compiled, /from ["'][^"']+\.tsx?["']/);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), DIST_FILES);
});

test("the compiled V2 modules reach no local filesystem or process API", async () => {
  for (const file of DIST_FILES) {
    const source = await readFile(join(root, "dist", file), "utf8");
    assert.doesNotMatch(source, /from ["']node:/, file);
    assert.doesNotMatch(source, /from ["'][^"']+\.tsx?["']/, file);
  }
});
