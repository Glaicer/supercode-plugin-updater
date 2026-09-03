import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the published TUI entrypoint is precompiled with Solid reactivity", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root });

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports?: { "./tui"?: unknown };
    files?: unknown;
  };
  const compiled = await readFile(join(root, "dist", "update-checker.js"), "utf8");

  assert.equal(packageJson.exports?.["./tui"], "./dist/update-checker.js");
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.match(compiled, /get focused\(\)/);
  assert.doesNotMatch(compiled, /from ["'][^"']+\.tsx?["']/);
});
