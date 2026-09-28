import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Plugin } from "@opencode/plugin/tui";
import { createManagedServerPort, createServiceControlPort } from "./service-control.ts";

const LOCAL_TMP = "/tmp/opencode";

function fakeClient(info: { pid: number; tmp: string } | "throw"): Plugin.Context["client"] {
  return {
    server: {
      info: async () => {
        if (info === "throw") throw new Error("unreachable");
        return { version: "2.0.18", pid: info.pid, urls: [], paths: { tmp: info.tmp } };
      },
    },
  } as unknown as Plugin.Context["client"];
}

function withServiceDir(t: import("node:test").TestContext, entries: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "service-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

function gate(serviceDir: string, info: { pid: number; tmp: string } | "throw", alive = true) {
  return createManagedServerPort(fakeClient(info), {
    tmpRoot: () => LOCAL_TMP,
    serviceDir: () => serviceDir,
    processAlive: () => alive,
  });
}

test("the managed local daemon is eligible: registered pid, local tmp, live process", async (t) => {
  const dir = withServiceDir(t, { "service.json": { id: "x", pid: 4242, url: "http://127.0.0.1:1" } });
  assert.deepEqual(await gate(dir, { pid: 4242, tmp: LOCAL_TMP }).verify(), { ok: true });
});

test("a remote or standalone server is never eligible", async (t) => {
  const dir = withServiceDir(t, { "service.json": { pid: 4242 } });
  // Local cache is not enough: a foreign tmp root means another machine.
  const remote = await gate(dir, { pid: 4242, tmp: "/somewhere/else/opencode" }).verify();
  assert.equal(remote.ok, false);
  // A local pid that no service file registered is a standalone/external server.
  const external = await gate(dir, { pid: 9999, tmp: LOCAL_TMP }).verify();
  assert.equal(external.ok, false);
  // A matching pid in a non-service file is not a managed registration.
  const notService = await withServiceDir(t, { "other.json": { pid: 4242 } });
  assert.equal((await gate(notService, { pid: 4242, tmp: LOCAL_TMP }).verify()).ok, false);
});

test("an unverifiable connection is ineligible, not assumed local", async (t) => {
  const dir = withServiceDir(t, { "service.json": { pid: 4242 } });
  // The server did not report its identity.
  assert.equal((await gate(dir, "throw").verify()).ok, false);
  // A dead process is not the live managed daemon.
  assert.equal((await gate(dir, { pid: 4242, tmp: LOCAL_TMP }, false).verify()).ok, false);
  // A channel-named registration still matches by pid.
  const channel = withServiceDir(t, { "service-beta.json": { pid: 7777 } });
  assert.deepEqual(await gate(channel, { pid: 7777, tmp: LOCAL_TMP }).verify(), { ok: true });
});

test("the reinstall hand-off launches the supervisor detached with the target cache and tools", () => {
  const spawns: { command: string; args: readonly string[] }[] = [];
  const control = createServiceControlPort({
    opencode: "oc",
    supervisor: "/dist/reinstall-supervisor.js",
    spawnDetached: (command, args) => spawns.push({ command, args }),
  });
  control.reinstall({ pid: 4242, cacheDir: "/cache/opencode", names: ["prettier", "oxfmt"] });
  assert.equal(spawns.length, 1);
  const { command, args } = spawns[0];
  assert.equal(command, "node");
  assert.deepEqual(args, [
    "/dist/reinstall-supervisor.js",
    "--pid",
    "4242",
    "--cache",
    "/cache/opencode",
    "--tools",
    "prettier,oxfmt",
    "--opencode",
    "oc",
  ]);
});
