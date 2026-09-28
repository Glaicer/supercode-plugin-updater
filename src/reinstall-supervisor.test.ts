import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  invalidateTools,
  isProcessStopped,
  runSequence,
  type Invalidations,
  type SupervisorDeps,
} from "./reinstall-supervisor.ts";

function recordingDeps(overrides: Partial<SupervisorDeps> = {}): {
  deps: SupervisorDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: SupervisorDeps = {
    stop: async () => {
      calls.push("stop");
      return 0;
    },
    isStopped: () => {
      calls.push("isStopped");
      return true;
    },
    invalidate: (names) => {
      calls.push(`invalidate:${names.join(",")}`);
      return { removed: [...names], failed: [] };
    },
    start: async () => {
      calls.push("start");
      return 0;
    },
    ...overrides,
  };
  return { deps, calls };
}

test("isProcessStopped reads a dead pid as stopped and a live one as not", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid as number;
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(isProcessStopped(pid), true);
  assert.equal(isProcessStopped(process.pid), false);
});

test("the sequence is stop → invalidate → start, and never invalidates before a confirmed stop", async () => {
  const { deps, calls } = recordingDeps();
  const result = await runSequence(4242, ["prettier"], deps);
  assert.deepEqual(calls, ["stop", "isStopped", "invalidate:prettier", "start"]);
  assert.equal(result.stopOk, true);
  assert.equal(result.started, true);
});

test("a failed stop leaves the cache untouched and still restores the server", async () => {
  // `service stop` exited non-zero: no invalidation, but start runs.
  const failedStop = recordingDeps({ stop: async () => 1 });
  const result = await runSequence(4242, ["prettier"], failedStop.deps);
  assert.equal(result.stopOk, false);
  assert.equal(result.invalidated, null);
  assert.ok(failedStop.calls.includes("start"));
  assert.ok(!failedStop.calls.some((call) => call.startsWith("invalidate")));

  // `service stop` reported success but the target process is still alive:
  // still no invalidation.
  const stillAlive = recordingDeps({ isStopped: () => false });
  const aliveResult = await runSequence(4242, ["prettier"], stillAlive.deps);
  assert.equal(aliveResult.stopOk, false);
  assert.equal(aliveResult.invalidated, null);
  assert.ok(!stillAlive.calls.some((call) => call.startsWith("invalidate")));
});

test("an invalidation error still restarts the server and reports partial success", async () => {
  const { deps, calls } = recordingDeps({
    invalidate: () => {
      throw new Error("EACCES");
    },
  });
  const result = await runSequence(4242, ["prettier", "oxfmt"], deps);
  assert.equal(result.stopOk, true);
  assert.ok(calls.includes("start"));
  assert.deepEqual(result.invalidated, {
    removed: [],
    failed: [
      { name: "prettier", error: "EACCES" },
      { name: "oxfmt", error: "EACCES" },
    ],
  });
});

test("invalidation removes every generation of only the selected tools", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reinstall-supervisor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, "cache");
  // Two generations of prettier (the one we remove), one of oxfmt and biome
  // (kept), plus a plugin cache that must never be touched.
  for (const [name, generations] of [
    ["prettier", ["1000", "2000"]],
    ["oxfmt", ["1000"]],
    ["@biomejs/biome", ["1000"]],
    ["@glaicer/supercode-plugin-updater", ["1000"]],
  ] as const) {
    for (const generation of generations) {
      mkdirSync(join(cache, "npm", `${name}@latest`, generation, "node_modules", name), { recursive: true });
      writeFileSync(join(cache, "npm", `${name}@latest`, generation, "node_modules", name, "package.json"), "{}");
    }
  }

  const result: Invalidations = invalidateTools(cache, ["prettier", "@glaicer/supercode-plugin-updater"]);
  // Only the supported selected tool is removed; the unsupported name is dropped.
  assert.deepEqual(result, { removed: ["prettier"], failed: [] });
  assert.equal(existsSync(join(cache, "npm", "prettier@latest")), false);
  assert.deepEqual(readdirSync(join(cache, "npm", "oxfmt@latest")), ["1000"]);
  assert.deepEqual(readdirSync(join(cache, "npm", "@biomejs/biome@latest")), ["1000"]);
  // The plugin cache and any other tool are out of scope and left alone.
  assert.equal(existsSync(join(cache, "npm", "@glaicer/supercode-plugin-updater@latest")), true);
});
