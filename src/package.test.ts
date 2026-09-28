import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DIST_FILES = [
  "checker.js",
  "durable-state.js",
  "managed-tools.js",
  "plugins.js",
  "reinstall-supervisor.js",
  "server-apply.js",
  "server-inventory.js",
  "server-updates.js",
  "service-control.js",
  "tool-reinstall.js",
  "tui-packages.js",
  "update-checker.js",
];

// Modules allowed to reach local filesystem/process APIs: the cache/identity
// reader and the two service adapters that spawn the CLI and the supervisor.
const LOCAL_STATE_ADAPTERS = ["tui-packages.js", "managed-tools.js", "service-control.js", "reinstall-supervisor.js"];

test("the published TUI entrypoint is precompiled with Solid reactivity", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports?: { "./tui"?: unknown };
    files?: unknown;
  };
  const compiled = await readFile(join(root, "dist", "update-checker.js"), "utf8");

  assert.equal(packageJson.exports?.["./tui"], "./dist/update-checker.js");
  assert.deepEqual(packageJson.files, ["dist", "tui.js"]);
  assert.match(compiled, /get each\(\)/);
  assert.match(compiled, /_\$effect/);
  assert.doesNotMatch(compiled, /from ["'][^"']+\.tsx?["']/);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), DIST_FILES);
});

test("the compiled V2 modules reach no local filesystem or process API beside the local-state adapters", async () => {
  for (const file of DIST_FILES) {
    const source = await readFile(join(root, "dist", file), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']+\.tsx?["']/, file);
    if (LOCAL_STATE_ADAPTERS.includes(file)) continue;
    assert.doesNotMatch(source, /from ["']node:/, file);
  }
});

test("the TUI adapter reads local state and runs the standard CLI without mutating anything", async () => {
  const source = await readFile(join(root, "dist", "tui-packages.js"), "utf8");
  // No cache deletion or local mutation: the adapter only reads cli.json and
  // the npm generations, and the only process it starts is the standard CLI
  // for one exact target — never update-all.
  assert.doesNotMatch(
    source,
    /\b(rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|renameSync|chmodSync|truncateSync|cpSync|mkdtempSync)\b/,
  );
  assert.match(source, /from ["']node:child_process["']/);
  assert.match(source, /\["plugin", "update", target\]/);
});

test("the managed tools adapter only reads the local cache and never mutates or spawns", async () => {
  const source = await readFile(join(root, "dist", "managed-tools.js"), "utf8");
  // The section is read-only: no install, removal, invalidation, or process.
  assert.doesNotMatch(
    source,
    /\b(rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|renameSync|chmodSync|truncateSync|cpSync|mkdtempSync|spawn|exec\()\b/,
  );
  assert.match(source, /from ["']node:fs["']/);
  assert.doesNotMatch(source, /from ["']node:child_process["']/);
});

test("the service adapter launches the supervisor detached and gates on the managed daemon", async () => {
  const source = await readFile(join(root, "dist", "service-control.js"), "utf8");
  // The supervisor must outlive the TUI: detached + unref, never a blocking child.
  assert.match(source, /detached:\s*true/);
  assert.match(source, /\.unref\(\)/);
  // The gate proves the connected server is the registered daemon before any restart.
  assert.match(source, /readdirSync/);
  assert.match(source, /registeredPids|service[^/]*\\.json/);
});

test("the detached supervisor stops, invalidates, and starts in that order and always restarts", async () => {
  const source = await readFile(join(root, "dist", "reinstall-supervisor.js"), "utf8");
  // Order is encoded in runSequence: stop, then invalidate, then start; the
  // invalidation is guarded by a confirmed stop and the start is unconditional.
  const stopIndex = source.indexOf('["service", "stop"]');
  const startIndex = source.indexOf('["service", "start"]');
  assert.ok(stopIndex !== -1 && startIndex !== -1, "the supervisor drives the real service CLI");
  assert.match(source, /deps\.invalidate/);
  assert.match(source, /deps\.start\(\)/);
});
