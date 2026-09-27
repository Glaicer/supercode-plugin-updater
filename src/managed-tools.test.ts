import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Plugin } from "@opencode/plugin/tui";
import { createManagedToolsPort, createServerLocalityPort } from "./managed-tools.ts";
import { installGeneration } from "./test-generations.ts";

function makeRoot(t: import("node:test").TestContext): { root: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "managed-tools-"));
  const cacheDir = join(root, "cache", "opencode");
  mkdirSync(cacheDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cacheDir };
}

function fakeClient(info: () => Promise<unknown>): Plugin.Context["client"] {
  return { server: { info: () => info() } } as unknown as Plugin.Context["client"];
}

test("installedVersion reads the newest generation, scoped names, and tolerates a broken manifest", (t) => {
  const { root, cacheDir } = makeRoot(t);
  installGeneration(cacheDir, "prettier", "1", "3.0.0");
  installGeneration(cacheDir, "prettier", "2", "3.1.0");
  installGeneration(cacheDir, "@biomejs/biome", "7", "2.0.0");
  installGeneration(cacheDir, "oxfmt", "1", null);
  const port = createManagedToolsPort({ cacheDir });
  assert.deepEqual(port.installed(), [
    { name: "prettier", version: "3.1.0" },
    { name: "oxfmt" },
    { name: "@biomejs/biome", version: "2.0.0" },
  ]);
});

test("a missing cache and non-formatter packages contribute nothing", (t) => {
  const { root, cacheDir } = makeRoot(t);
  const port = createManagedToolsPort({ cacheDir });
  assert.deepEqual(port.installed(), []);

  // An LSP server the host manages is not one of the three formatters.
  installGeneration(cacheDir, "pyright", "1", "1.0.0");
  // A pinned spec directory is not a host-managed formatter install.
  const pinned = join(cacheDir, "npm", "prettier@3.0.0", "1", "node_modules", "prettier");
  mkdirSync(pinned, { recursive: true });
  writeFileSync(join(pinned, "package.json"), JSON.stringify({ name: "prettier", version: "3.0.0" }));
  assert.deepEqual(port.installed(), []);
});

test("the V1 cache layout is never taken for the V2 generation cache", (t) => {
  const { root, cacheDir } = makeRoot(t);
  const v1Tool = join(cacheDir, "packages", "prettier", "node_modules", "prettier");
  mkdirSync(v1Tool, { recursive: true });
  writeFileSync(join(v1Tool, "package.json"), JSON.stringify({ name: "prettier", version: "1.0.0" }));
  const v1Plugin = join(cacheDir, "packages", "prettier@latest", "3", "node_modules", "prettier");
  mkdirSync(v1Plugin, { recursive: true });
  writeFileSync(join(v1Plugin, "package.json"), JSON.stringify({ name: "prettier", version: "2.0.0" }));
  const port = createManagedToolsPort({ cacheDir });
  assert.deepEqual(port.installed(), []);
});

test("locality holds when the server tmp root and process id describe this machine", async (t) => {
  const { root } = makeRoot(t);
  const tmpRoot = join(root, "tmp-root");
  mkdirSync(tmpRoot, { recursive: true });
  const port = createServerLocalityPort(
    fakeClient(async () => ({ version: "2.0.16", pid: process.pid, urls: [], paths: { tmp: tmpRoot } })),
    { tmpRoot: () => tmpRoot },
  );
  assert.deepEqual(await port.verify(), { local: true });
});

test("a foreign tmp root, a dead process, or pid 0 is not verifiably local", async (t) => {
  const { root } = makeRoot(t);
  const tmpRoot = join(root, "tmp-root");
  mkdirSync(tmpRoot, { recursive: true });
  const create = (info: () => Promise<unknown>, processAlive: (pid: number) => boolean = () => true) =>
    createServerLocalityPort(fakeClient(info), { tmpRoot: () => tmpRoot, processAlive });

  const remote = create(async () => ({ pid: process.pid, paths: { tmp: "/remote/tmp/opencode" } }));
  assert.deepEqual(await remote.verify(), { local: false, reason: "the connected server is not on this machine" });

  const dead = create(async () => ({ pid: 999_999, paths: { tmp: tmpRoot } }), () => false);
  assert.deepEqual(await dead.verify(), { local: false, reason: "the connected server is not on this machine" });

  const noIdentity = create(async () => ({ pid: 0, paths: { tmp: tmpRoot } }));
  assert.deepEqual(await noIdentity.verify(), { local: false, reason: "the connected server is not on this machine" });

  const broken = create(async () => ({ paths: {} }));
  assert.deepEqual(await broken.verify(), { local: false, reason: "the connected server is not on this machine" });
});

test("a failing identity request counts as unavailable, not as remote evidence", async (t) => {
  const { root } = makeRoot(t);
  const port = createServerLocalityPort(
    fakeClient(async () => {
      throw Error("offline");
    }),
    { tmpRoot: () => join(root, "tmp-root"), processAlive: () => true },
  );
  assert.deepEqual(await port.verify(), { local: false, reason: "the server did not report its identity" });
});

test("a local tmp root that cannot be resolved keeps the section unavailable", async (t) => {
  const { root } = makeRoot(t);
  const port = createServerLocalityPort(
    fakeClient(async () => ({ pid: process.pid, paths: { tmp: join(root, "tmp-root") } })),
    {
      tmpRoot: () => {
        throw Error("no tmp");
      },
      processAlive: () => true,
    },
  );
  assert.deepEqual(await port.verify(), { local: false, reason: "the connected server is not on this machine" });
});

test("the default process-alive check accepts a live process id", async (t) => {
  const { root } = makeRoot(t);
  const tmpRoot = join(root, "tmp-root");
  mkdirSync(tmpRoot, { recursive: true });
  const port = createServerLocalityPort(
    fakeClient(async () => ({ pid: process.pid, paths: { tmp: tmpRoot } })),
    { tmpRoot: () => tmpRoot },
  );
  assert.deepEqual(await port.verify(), { local: true });
});
