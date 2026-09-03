import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createNpmRegistryPort, type FetchLatest } from "./checker.ts";
import {
  CHECK_INTERVAL_MS,
  REGISTRY_CONCURRENCY,
  REGISTRY_TIMEOUT_MS,
  createUpdateModel,
  type CheckResult,
  type UpdateCandidate,
} from "./update-model.ts";
import { createFakeTuiApi } from "./fake-tui-api.ts";
import { MANAGED_TOOLS } from "./tools.ts";

type Config = TuiPluginApi["state"]["config"];

async function withCacheRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "plugin-updater-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeNodeModulesManifest(key: string, name: string, content: string): Promise<void> {
  const dir = join(key, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), content);
}

async function installPackage(
  root: string,
  name: string,
  version: string,
  manifest?: object,
): Promise<void> {
  await writeCacheManifest(root, name, JSON.stringify(manifest ?? { name, version }));
}

async function writeCacheManifest(
  root: string,
  name: string,
  content: string,
): Promise<void> {
  await writeNodeModulesManifest(join(root, `${name}@latest`), name, content);
}

async function installLegacyGeneration(root: string, name: string, version: string): Promise<void> {
  await writeNodeModulesManifest(join(root, ...name.split("/")), name, JSON.stringify({ name, version }));
}

interface SpyPort {
  fetchLatest: FetchLatest;
  readonly calls: readonly string[];
  readonly maxInflight: number;
}

function spyPort(handler: (name: string) => Promise<{ version: string }>): SpyPort {
  const calls: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    calls,
    get maxInflight() {
      return maxInflight;
    },
    fetchLatest: async (name) => {
      calls.push(name);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        return await handler(name);
      } finally {
        inflight--;
      }
    },
  };
}

interface HarnessOptions {
  specs?: unknown[];
  tuiSpecs?: unknown[];
  now?: () => number;
  timeoutMs?: number;
  concurrency?: number;
}

function makeHarness(
  port: FetchLatest,
  cacheRoot: string,
  options: HarnessOptions = {},
): { fake: ReturnType<typeof createFakeTuiApi>; build: () => ReturnType<typeof createUpdateModel> } {
  const fake = createFakeTuiApi({ plugin: (options.specs ?? []) as string[] } as Partial<Config>, {
    plugin: (options.tuiSpecs ?? []) as never,
  });
  return {
    fake,
    build: () =>
      createUpdateModel(fake.api, {
        fetchLatest: port,
        cacheRoot,
        now: options.now,
        timeoutMs: options.timeoutMs,
        concurrency: options.concurrency,
      }),
  };
}

function makeModel(
  specs: unknown[],
  port: FetchLatest,
  cacheRoot: string,
  options?: { timeoutMs?: number; concurrency?: number },
): ReturnType<typeof createUpdateModel> {
  return makeHarness(port, cacheRoot, { specs, ...options }).build();
}

function candidateBySpec(result: CheckResult, spec: string): UpdateCandidate {
  const candidate = result.candidates.find((c) => c.spec === spec);
  assert.ok(candidate, `candidate for ${spec} must exist`);
  return candidate;
}

test("floating spec: candidate carries the installed→latest pair and the update flag", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "1.1.0" }));
    const model = makeModel(["foo"], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.candidates, [
      {
        kind: "plugin",
        spec: "foo",
        name: "foo",
        status: "checked",
        installedVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
      },
    ]);
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("three categories: floating checked, pinned info-only without registry, unsupported skipped", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const model = makeModel(
      [
        "foo",
        "bar@1.2.3",
        "./local-plugin",
        "file:./local.tgz",
        "https://example.com/x.tgz",
        "git+https://example.com/x.git",
      ],
      port.fetchLatest,
      root,
    );

    const result = await model.runCheck();

    const foo = candidateBySpec(result, "foo");
    assert.equal(foo.status, "checked");
    assert.equal(foo.installedVersion, "1.0.0");
    assert.equal(foo.latestVersion, "2.0.0");
    assert.equal(foo.updateAvailable, true);

    const bar = candidateBySpec(result, "bar@1.2.3");
    assert.equal(bar.status, "pinned");
    assert.equal(bar.pinnedVersion, "1.2.3");
    assert.equal(bar.latestVersion, undefined);
    assert.equal(bar.updateAvailable, undefined);

    assert.deepEqual(result.skipped, [
      { kind: "plugin", spec: "./local-plugin", reason: "local path" },
      { kind: "plugin", spec: "file:./local.tgz", reason: "file path" },
      { kind: "plugin", spec: "https://example.com/x.tgz", reason: "URL spec" },
      { kind: "plugin", spec: "git+https://example.com/x.git", reason: "git URL" },
    ]);
    for (const spec of ["./local-plugin", "file:./local.tgz", "https://example.com/x.tgz", "git+https://example.com/x.git"]) {
      assert.ok(!result.candidates.some((c) => c.spec === spec), spec);
    }

    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("bare name is checked against the name@latest generation, not the legacy dir", async () => {
  await withCacheRoot(async (root) => {
    await installLegacyGeneration(root, "foo", "9.9.9");
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "1.1.0" }));
    const model = makeModel(["foo"], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.equal(candidateBySpec(result, "foo").installedVersion, "1.0.0");
  });
});

test("foo@latest is the same Floating Spec as foo", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "1.1.0" }));
    const model = makeModel(["foo@latest"], port.fetchLatest, root);

    const result = await model.runCheck();

    const candidate = candidateBySpec(result, "foo@latest");
    assert.equal(candidate.name, "foo");
    assert.equal(candidate.status, "checked");
    assert.equal(candidate.updateAvailable, true);
  });
});

test("scoped package with two generations reads the current resolver dir", async () => {
  await withCacheRoot(async (root) => {
    await installLegacyGeneration(root, "@scope/name", "0.0.1");
    await installPackage(root, "@scope/name", "0.2.0");
    const port = spyPort(async () => ({ version: "0.3.0" }));
    const model = makeModel(["@scope/name"], port.fetchLatest, root);

    const result = await model.runCheck();

    const candidate = candidateBySpec(result, "@scope/name");
    assert.equal(candidate.installedVersion, "0.2.0");
    assert.equal(candidate.updateAvailable, true);
  });
});

test("missing, garbage, and versionless cache manifests give unknown, not an exception", async () => {
  await withCacheRoot(async (root) => {
    await mkdir(join(root, "no-manifest@latest", "node_modules", "no-manifest"), { recursive: true });
    await writeCacheManifest(root, "garbage", "{not json");
    await installPackage(root, "versionless", "", { name: "versionless", version: 3 });
    const port = spyPort(async (name) => ({ version: `2.0.0-for-${name}` }));
    const model = makeModel(["no-manifest", "garbage", "versionless"], port.fetchLatest, root);

    const result = await model.runCheck();

    for (const spec of ["no-manifest", "garbage", "versionless"]) {
      const candidate = candidateBySpec(result, spec);
      assert.equal(candidate.status, "unknown", spec);
      assert.equal(candidate.installedVersion, undefined, spec);
      assert.equal(candidate.updateAvailable, undefined, spec);
    }
    assert.deepEqual([...port.calls].sort(), ["garbage", "no-manifest", "versionless"]);
  });
});

test("comparison table: updateAvailable on numeric triple, unknown on unparsable", async () => {
  await withCacheRoot(async (root) => {
    const table: readonly { installed: string; latest: string; expected: boolean | undefined }[] = [
      { installed: "1.2.3", latest: "1.2.4", expected: true },
      { installed: "1.2.3", latest: "1.3.0", expected: true },
      { installed: "1.2.3", latest: "2.0.0", expected: true },
      { installed: "2.0.0", latest: "2.0.0", expected: false },
      { installed: "2.0.0", latest: "1.9.9", expected: false },
      { installed: "1.9.0", latest: "1.10.0", expected: true },
      { installed: "1.10.0", latest: "1.9.0", expected: false },
      { installed: "0.0.1", latest: "0.0.2", expected: true },
      { installed: "banana", latest: "2.0.0", expected: undefined },
      { installed: "1.2.3", latest: "banana", expected: undefined },
    ];
    const specs: string[] = [];
    const latestByName = new Map<string, string>();
    for (const [index, row] of table.entries()) {
      const name = `pkg-${index}`;
      specs.push(name);
      await installPackage(root, name, row.installed);
      latestByName.set(name, row.latest);
    }
    const port = spyPort(async (name) => ({ version: latestByName.get(name)! }));
    const model = makeModel(specs, port.fetchLatest, root);

    const result = await model.runCheck();

    for (const [index, row] of table.entries()) {
      const candidate = candidateBySpec(result, `pkg-${index}`);
      assert.equal(candidate.updateAvailable, row.expected, `${row.installed} → ${row.latest}`);
      assert.equal(
        candidate.status,
        row.expected === undefined ? "unknown" : "checked",
        `${row.installed} → ${row.latest}`,
      );
    }
  });
});

test("one package failing (404-style rejection) gives unknown; the rest are still checked", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "baz", "1.0.0");
    const port = spyPort(async (name) => {
      if (name === "foo") throw new Error("registry: foo/latest responded 404");
      return { version: "2.0.0" };
    });
    const model = makeModel(["foo", "baz"], port.fetchLatest, root);

    const result = await model.runCheck();

    const foo = candidateBySpec(result, "foo");
    assert.equal(foo.status, "unknown");
    assert.equal(foo.reason, "registry lookup failed");
    assert.equal(foo.latestVersion, undefined);
    const baz = candidateBySpec(result, "baz");
    assert.equal(baz.status, "checked");
    assert.equal(baz.updateAvailable, true);
  });
});

test("default registry port over frozen JSON fixtures: 200, 404, and garbage JSON", async () => {
  await withCacheRoot(async (root) => {
    for (const name of ["foo", "gone", "junk"]) await installPackage(root, name, "1.0.0");
    const bodies = new Map<string, () => Response>([
      ["foo", () => new Response(JSON.stringify({ name: "foo", version: "2.0.0" }), { status: 200 })],
      ["gone", () => new Response("Not Found", { status: 404 })],
      ["junk", () => new Response("<html>not json</html>", { status: 200 })],
    ]);
    const port = createNpmRegistryPort({
      fetchImpl: async (url) => {
        const name = decodeURIComponent(/\/([^/]+)\/latest$/.exec(String(url))![1]!);
        return bodies.get(name)!();
      },
    });
    const model = makeModel(["foo", "gone", "junk"], port, root);

    const result = await model.runCheck();

    assert.equal(candidateBySpec(result, "foo").status, "checked");
    assert.equal(candidateBySpec(result, "foo").latestVersion, "2.0.0");
    for (const spec of ["gone", "junk"]) {
      const candidate = candidateBySpec(result, spec);
      assert.equal(candidate.status, "unknown", spec);
      assert.equal(candidate.reason, "registry lookup failed", spec);
    }
  });
});

test("a hung registry request is cut by the per-request timeout and yields unknown", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "baz", "1.0.0");
    const port = spyPort(async (name) => {
      if (name === "foo") return new Promise(() => {});
      return { version: "2.0.0" };
    });
    const model = makeModel(["foo", "baz"], port.fetchLatest, root, { timeoutMs: 20 });

    const result = await model.runCheck();

    const foo = candidateBySpec(result, "foo");
    assert.equal(foo.status, "unknown");
    assert.equal(foo.reason, "registry lookup failed");
    assert.equal(candidateBySpec(result, "baz").status, "checked");
  });
});

test("registry lookups flow through a fixed-size pool", async () => {
  await withCacheRoot(async (root) => {
    const specs = ["a", "b", "c", "d", "e", "f"].map((n) => `pkg-${n}`);
    for (const name of specs) await installPackage(root, name, "1.0.0");
    const port = spyPort(async (name) => {
      // Hold every request briefly so all pool workers fill up first.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { version: `2.0.0-for-${name}` };
    });
    const model = makeModel(specs, port.fetchLatest, root);

    const result = await model.runCheck();

    assert.equal(port.maxInflight, REGISTRY_CONCURRENCY);
    assert.deepEqual([...port.calls].sort(), [...specs].sort());
    assert.ok(result.candidates.every((c) => c.status === "checked"));
  });
});

test("a tighter concurrency option bounds the pool further", async () => {
  await withCacheRoot(async (root) => {
    const specs = ["a", "b", "c", "d"].map((n) => `pkg-${n}`);
    for (const name of specs) await installPackage(root, name, "1.0.0");
    const port = spyPort(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { version: "2.0.0" };
    });
    const model = makeModel(specs, port.fetchLatest, root, { concurrency: 2 });

    await model.runCheck();

    assert.equal(port.maxInflight, 2);
  });
});

test("registry is asked only for packages whose cache dir exists", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const model = makeModel(["foo", "not-installed"], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.deepEqual([...port.calls], ["foo"]);
    const missing = candidateBySpec(result, "not-installed");
    assert.equal(missing.status, "unknown");
    assert.equal(missing.reason, "not in cache");
  });
});

test("empty plugin config yields an empty list, not an exception", async () => {
  await withCacheRoot(async (root) => {
    const empty = makeModel([], async () => ({ version: "1.0.0" }), root);
    const emptyResult = await empty.runCheck();
    assert.deepEqual(emptyResult.candidates, []);
    assert.deepEqual(emptyResult.skipped, []);

    const absent = createFakeTuiApi({});
    const absentModel = createUpdateModel(absent.api, {
      fetchLatest: async () => ({ version: "1.0.0" }),
      cacheRoot: root,
    });
    const absentResult = await absentModel.runCheck();
    assert.deepEqual(absentResult.candidates, []);
    assert.deepEqual(absentResult.skipped, []);
  });
});

test("semver-range and dist-tag specs are skipped with a reason", async () => {
  await withCacheRoot(async (root) => {
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const model = makeModel(["foo@^1.2.0", "foo@~1.2.0", "foo@1.2", "foo@*", "foo@next", "C:\\dev\\plugin"], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.deepEqual(result.candidates, []);
    assert.deepEqual(
      result.skipped.map((s) => [s.spec, s.reason]),
      [
        ["foo@^1.2.0", "semver range"],
        ["foo@~1.2.0", "semver range"],
        ["foo@1.2", "semver range"],
        ["foo@*", "semver range"],
        ["foo@next", "dist-tag"],
        ["C:\\dev\\plugin", "local path"],
      ],
    );
    assert.deepEqual([...port.calls], []);
  });
});

test("non-string config entries are ignored defensively", async () => {
  await withCacheRoot(async (root) => {
    const fake = createFakeTuiApi({
      plugin: [42, "foo"] as unknown as string[],
    } as Partial<Config>);
    await installPackage(root, "foo", "1.0.0");
    const model = createUpdateModel(fake.api, {
      fetchLatest: async () => ({ version: "2.0.0" }),
      cacheRoot: root,
    });

    const result = await model.runCheck();

    assert.deepEqual(
      result.candidates.map((c) => c.spec),
      ["foo"],
    );
    assert.deepEqual(result.skipped, []);
  });
});

test("tui.json plugins are checked alongside opencode.json plugins", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "tui-only", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, { specs: ["foo"], tuiSpecs: ["tui-only"] });

    const result = await build().runCheck();

    assert.deepEqual(
      result.candidates.map((c) => [c.kind, c.spec]),
      [
        ["plugin", "foo"],
        ["plugin", "tui-only"],
      ],
    );
    assert.deepEqual([...port.calls].sort(), ["foo", "tui-only"]);
  });
});

test("tui.json tuple entries contribute their spec string; garbage entries are ignored", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, {
      tuiSpecs: [["foo", { label: "demo" }], 42, [42], "./tui-plugins/local.tsx"],
    });

    const result = await build().runCheck();

    assert.deepEqual(
      result.candidates.map((c) => c.spec),
      ["foo"],
    );
    assert.deepEqual(result.skipped, [{ kind: "plugin", spec: "./tui-plugins/local.tsx", reason: "local path" }]);
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("opencode.json tuple entries contribute their spec string", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, {
      specs: [["foo", { custom: true }]],
    });

    const result = await build().runCheck();

    assert.deepEqual(
      result.candidates.map((c) => c.spec),
      ["foo"],
    );
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("a spec listed in both configs is checked once", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, { specs: ["foo"], tuiSpecs: ["foo"] });

    const result = await build().runCheck();

    assert.deepEqual(
      result.candidates.map((c) => c.spec),
      ["foo"],
    );
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("default registry timeout is ~5s", () => {
  assert.equal(REGISTRY_TIMEOUT_MS, 5000);
});

async function installTool(root: string, name: string, version: string, manifest?: object): Promise<void> {
  await writeToolManifest(root, name, JSON.stringify(manifest ?? { name, version }));
}

async function writeToolManifest(root: string, name: string, content: string): Promise<void> {
  await writeNodeModulesManifest(join(root, name), name, content);
}

test("known tool set is data and contains the spec's examples", () => {
  for (const name of [
    "bash-language-server",
    "pyright",
    "typescript-language-server",
    "yaml-language-server",
    "prettier",
    "oxfmt",
    "@biomejs/biome",
    "@vue/language-server",
    "svelte-language-server",
    "intelephense",
    "dockerfile-language-server-nodejs",
    "@astrojs/language-server",
  ]) {
    assert.ok(MANAGED_TOOLS.includes(name), name);
  }
});

test("managed tools: candidates only for known set ∩ existing cache dirs; foreign dirs never contacted", async () => {
  await withCacheRoot(async (root) => {
    await installTool(root, "pyright", "1.1.411");
    await installTool(root, "prettier", "3.8.4");
    await mkdir(join(root, "superpowers@git+https:"), { recursive: true });
    await installPackage(root, "left-pad", "1.0.0");
    const port = spyPort(async () => ({ version: "9.9.9" }));
    const model = makeModel([], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.deepEqual(
      result.candidates.map((c) => [c.kind, c.spec]),
      [
        ["tool", "pyright"],
        ["tool", "prettier"],
      ],
    );
    assert.deepEqual([...port.calls].sort(), ["prettier", "pyright"]);
  });
});

test("tool candidates take the same version/unknown path as plugins", async () => {
  await withCacheRoot(async (root) => {
    await installTool(root, "pyright", "1.1.411");
    await installTool(root, "bash-language-server", "5.6.0");
    await writeToolManifest(root, "prettier", "{not json");
    const port = spyPort(async (name) => {
      if (name === "bash-language-server") throw new Error("registry: bash-language-server/latest responded 404");
      return { version: "9.9.9" };
    });
    const model = makeModel([], port.fetchLatest, root);

    const result = await model.runCheck();

    const pyright = candidateBySpec(result, "pyright");
    assert.equal(pyright.kind, "tool");
    assert.equal(pyright.status, "checked");
    assert.equal(pyright.installedVersion, "1.1.411");
    assert.equal(pyright.latestVersion, "9.9.9");
    assert.equal(pyright.updateAvailable, true);

    const bash = candidateBySpec(result, "bash-language-server");
    assert.equal(bash.kind, "tool");
    assert.equal(bash.status, "unknown");
    assert.equal(bash.reason, "registry lookup failed");
    assert.equal(bash.updateAvailable, undefined);

    const prettier = candidateBySpec(result, "prettier");
    assert.equal(prettier.status, "unknown");
    assert.equal(prettier.installedVersion, undefined);
    assert.equal(prettier.reason, "version not parseable");
  });
});

test("machine without a tools cache yields an empty tool category, not an exception", async () => {
  await withCacheRoot(async (root) => {
    const port = spyPort(async () => ({ version: "9.9.9" }));
    const model = makeModel([], port.fetchLatest, join(root, "does-not-exist"));

    const result = await model.runCheck();

    assert.deepEqual(result.candidates, []);
    assert.deepEqual([...port.calls], []);
  });
});

test("mixed cycle: plugins and tools land in one candidate list", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installTool(root, "pyright", "1.1.411");
    const port = spyPort(async () => ({ version: "9.9.9" }));
    const model = makeModel(["foo"], port.fetchLatest, root);

    const result = await model.runCheck();

    assert.deepEqual(
      result.candidates.map((c) => [c.kind, c.spec]),
      [
        ["plugin", "foo"],
        ["tool", "pyright"],
      ],
    );
  });
});

const HOUR_MS = 60 * 60 * 1000;
const TOAST_MESSAGE = (count: number): string =>
  `${count} OpenCode updates available. Run /plugin-updates to review them.`;

test("first start with no lastCheck runs the cycle and toasts once with the update count", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "bar", "5.0.0");
    await installTool(root, "pyright", "1.1.411");
    const port = spyPort(async () => ({ version: "9.9.9" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "bar"] });

    await build().start();

    assert.equal(fake.toasts.length, 1);
    assert.equal(fake.toasts[0]?.message, TOAST_MESSAGE(3));
  });
});

test("fresh lastCheck: start skips the cycle — no registry traffic, no toast", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    await build().start();
    assert.equal(fake.toasts.length, 1);

    await build().start();
    assert.deepEqual([...port.calls], ["foo"]);
    assert.equal(fake.toasts.length, 1);
  });
});

test("fresh lastCheck is bypassed when the configured plugin universe changes", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "server-plugin", "1.0.0");
    await installPackage(root, "tui-plugin", "1.0.0");
    const port = spyPort(async () => ({ version: "1.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, {
      specs: ["server-plugin"],
      now: () => 1_000_000,
    });

    await build().start();
    assert.deepEqual([...port.calls], ["server-plugin"]);

    fake.setTuiConfig({ plugin: ["tui-plugin"] });
    const refreshed = build();
    await refreshed.start();

    assert.deepEqual([...port.calls], ["server-plugin", "server-plugin", "tui-plugin"]);
    assert.deepEqual(
      refreshed.getSnapshot()?.candidates.map((candidate) => candidate.spec),
      ["server-plugin", "tui-plugin"],
    );
  });
});

test("fresh snapshots from before plugin-universe tracking are refreshed once", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "server-plugin", "1.0.0");
    await installPackage(root, "tui-plugin", "1.0.0");
    const port = spyPort(async () => ({ version: "1.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, {
      specs: ["server-plugin"],
      now: () => 1_000_000,
    });

    await build().start();
    fake.kv.delete("plugin-updates.checkedPluginSpecs");
    fake.setTuiConfig({ plugin: ["tui-plugin"] });

    const upgraded = build();
    await upgraded.start();

    assert.deepEqual([...port.calls], ["server-plugin", "server-plugin", "tui-plugin"]);
    assert.deepEqual(
      upgraded.getSnapshot()?.candidates.map((candidate) => candidate.spec),
      ["server-plugin", "tui-plugin"],
    );
  });
});

test("stale lastCheck — exactly and well past 24h — re-runs the cycle", async () => {
  await withCacheRoot(async (root) => {
    let now = 1_000_000;
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"], now: () => now });

    await build().start();
    assert.deepEqual([...port.calls], ["foo"]);
    assert.equal(fake.toasts.length, 1);

    now += CHECK_INTERVAL_MS;
    await build().start();
    assert.deepEqual([...port.calls], ["foo", "foo"]);
    assert.equal(fake.toasts.length, 2);

    now += CHECK_INTERVAL_MS + HOUR_MS;
    await build().start();
    assert.deepEqual([...port.calls], ["foo", "foo", "foo"]);
    assert.equal(fake.toasts.length, 3);
  });
});

test("full registry outage: the cycle does not count — no toast, lastCheck unmoved, next start retries", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    let healthy = false;
    const port = spyPort(async () => {
      if (!healthy) throw new Error("registry: network unreachable");
      return { version: "2.0.0" };
    });
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    await build().start();
    assert.deepEqual(fake.toasts, []);
    assert.deepEqual([...port.calls], ["foo"]);

    await build().start();
    assert.deepEqual([...port.calls], ["foo", "foo"]);
    assert.deepEqual(fake.toasts, []);

    healthy = true;
    await build().start();
    assert.deepEqual([...port.calls], ["foo", "foo", "foo"]);
    assert.equal(fake.toasts.length, 1);
  });
});

test("one package failing among successes: the cycle counts — toast fires, lastCheck moves", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "baz", "1.0.0");
    const port = spyPort(async (name) => {
      if (name === "foo") throw new Error("registry: foo/latest responded 404");
      return { version: "2.0.0" };
    });
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "baz"] });

    await build().start();

    assert.deepEqual(fake.toasts.map((t) => t.message), [TOAST_MESSAGE(1)]);

    const next = build();
    await next.start();
    assert.deepEqual([...port.calls], ["foo", "baz"]);

    const snapshot = next.getSnapshot();
    assert.ok(snapshot);
    assert.equal(candidateBySpec(snapshot, "foo").status, "unknown");
    assert.equal(candidateBySpec(snapshot, "baz").updateAvailable, true);
  });
});

test("manual runCheck ignores TTL, never toasts, and still moves lastCheck", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    await build().start();
    assert.equal(fake.toasts.length, 1);

    await build().runCheck();
    assert.deepEqual([...port.calls], ["foo", "foo"]);
    assert.equal(fake.toasts.length, 1);

    const manualModel = build();
    const manualSnapshot = manualModel.getSnapshot();
    assert.ok(manualSnapshot);
    assert.equal(candidateBySpec(manualSnapshot, "foo").updateAvailable, true);

    await manualModel.start();
    assert.deepEqual([...port.calls], ["foo", "foo"]);
    assert.equal(fake.toasts.length, 1);
  });
});

test("manual runCheck on a full registry outage does not move lastCheck either", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => {
      throw new Error("registry: network unreachable");
    });
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    const result = await build().runCheck();
    assert.equal(candidateBySpec(result, "foo").status, "unknown");
    assert.deepEqual(fake.toasts, []);

    await build().start();
    assert.deepEqual([...port.calls], ["foo", "foo"]);
    assert.deepEqual(fake.toasts, []);
  });
});

test("empty check universe: the cycle trivially succeeds — no toast, snapshot stored", async () => {
  await withCacheRoot(async (root) => {
    const port = spyPort(async () => {
      throw new Error("no lookups without checkable entries");
    });
    const { fake, build } = makeHarness(port.fetchLatest, root);

    const model = build();
    await model.start();

    assert.deepEqual(fake.toasts, []);
    const snapshot = model.getSnapshot();
    assert.ok(snapshot);
    assert.deepEqual([...snapshot.candidates], []);
    assert.deepEqual([...snapshot.skipped], []);
  });
});

test("getSnapshot serves the last successful cycle from state, without registry traffic", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    assert.equal(build().getSnapshot(), undefined);

    await build().start();

    const revived = build();
    const snapshot = revived.getSnapshot();
    assert.ok(snapshot);
    assert.equal(candidateBySpec(snapshot, "foo").updateAvailable, true);
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("a cycle after the update is applied (cache holds latest) offers nothing and toasts nothing", async () => {
  await withCacheRoot(async (root) => {
    let now = 0;
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"], now: () => now });

    await build().start();
    assert.equal(fake.toasts.length, 1);

    await installPackage(root, "foo", "2.0.0");
    now += CHECK_INTERVAL_MS;

    const model = build();
    await model.start();

    assert.equal(fake.toasts.length, 1);
    const snapshot = model.getSnapshot();
    assert.ok(snapshot);
    assert.equal(candidateBySpec(snapshot, "foo").updateAvailable, false);
  });
});

test("start() decides asynchronously — no registry traffic before it yields", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    const started = build().start();
    assert.deepEqual([...port.calls], []);
    await started;
    assert.deepEqual([...port.calls], ["foo"]);
  });
});

test("all persisted state lives under the plugin-updates prefix", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    await build().start();

    const keys = [...fake.kv.keys()];
    assert.ok(keys.length >= 2, "a successful cycle persists lastCheck and available");
    for (const key of keys) assert.ok(key.startsWith("plugin-updates."), key);
  });
});

test("a corrupt lastCheck is treated as absent, not as fresh", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    fake.kv.set("plugin-updates.lastCheck", "yesterday-ish");
    await build().start();

    assert.deepEqual([...port.calls], ["foo"]);
  });
});

const PENDING_KEY = "plugin-updates.pending";
const PREPARED_TOAST = "Updates prepared. Restart OpenCode to apply them.";
const SKIP_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0 ? "permission fixtures require a non-root user" : false;

test("confirm writes the pending marker, toasts exactly once, and touches no files", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installTool(root, "pyright", "1.1.411");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });
    const model = build();

    model.confirm([
      { kind: "plugin", spec: "foo" },
      { kind: "tool", spec: "pyright" },
    ]);

    assert.deepEqual(fake.kv.get(PENDING_KEY), [
      { kind: "plugin", spec: "foo" },
      { kind: "tool", spec: "pyright" },
    ]);
    assert.deepEqual(fake.toasts.map((t) => t.message), [PREPARED_TOAST]);
    assert.equal(model.state, "pending-restart");
    assert.ok(existsSync(join(root, "foo@latest")));
    assert.ok(existsSync(join(root, "pyright")));
  });
});

test("confirm with an empty selection is a no-op — no marker, no toast", async () => {
  await withCacheRoot(async (root) => {
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });
    const model = build();

    model.confirm([]);

    assert.equal(fake.kv.get(PENDING_KEY), undefined);
    assert.deepEqual(fake.toasts, []);
    assert.equal(model.state, "idle");
  });
});

test("the captured dispose callback removes only the selected packages' dirs", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "bar", "1.0.0");
    await installPackage(root, "left-pad", "1.0.0");
    await installTool(root, "pyright", "1.1.411");
    await installTool(root, "prettier", "3.8.4");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "bar"] });
    const model = build();
    model.confirm([
      { kind: "plugin", spec: "foo" },
      { kind: "tool", spec: "pyright" },
    ]);

    assert.equal(fake.disposeCallbacks.length, 1);
    await fake.disposeCallbacks[0]!();

    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.ok(!existsSync(join(root, "pyright")));
    assert.ok(existsSync(join(root, "bar@latest")));
    assert.ok(existsSync(join(root, "left-pad@latest")));
    assert.ok(existsSync(join(root, "prettier")));
    assert.ok(existsSync(root));
    assert.equal(fake.kv.get(PENDING_KEY), null);
    assert.equal(model.state, "idle");
  });
});

test("consumption is element-wise: a failed dir keeps its marker entry, the rest are erased", { skip: SKIP_AS_ROOT }, async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "baz", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "baz"] });
    const model = build();
    model.confirm([
      { kind: "plugin", spec: "foo" },
      { kind: "plugin", spec: "baz" },
    ]);

    const doomed = join(root, "baz@latest");
    await chmod(doomed, 0o500);
    try {
      await fake.disposeCallbacks[0]!();
    } finally {
      await chmod(doomed, 0o700);
    }

    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.ok(existsSync(doomed));
    assert.deepEqual(fake.kv.get(PENDING_KEY), [{ kind: "plugin", spec: "baz" }]);
    assert.equal(model.state, "cache-invalidated");
  });
});

test("scoped package with two generations: dispose removes the current resolver dir only", async () => {
  await withCacheRoot(async (root) => {
    await installLegacyGeneration(root, "@scope/name", "0.0.1");
    await installPackage(root, "@scope/name", "0.2.0");
    const port = spyPort(async () => ({ version: "0.3.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["@scope/name"] });
    build().confirm([{ kind: "plugin", spec: "@scope/name" }]);

    await fake.disposeCallbacks[0]!();

    assert.ok(!existsSync(join(root, "@scope", "name@latest")));
    assert.ok(existsSync(join(root, "@scope", "name")));
  });
});

test("one package marked as both kinds resolves each kind's own dir", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "prettier", "1.0.0");
    await installTool(root, "prettier", "3.8.4");
    await installTool(root, "oxfmt", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["prettier@latest"] });
    build().confirm([
      { kind: "plugin", spec: "prettier@latest" },
      { kind: "tool", spec: "prettier" },
    ]);

    await fake.disposeCallbacks[0]!();

    assert.ok(!existsSync(join(root, "prettier@latest")));
    assert.ok(!existsSync(join(root, "prettier")));
    assert.ok(existsSync(join(root, "oxfmt")));
  });
});

test("recovery: a new start over the same kv drains pending before the 24h decision", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    const first = build();
    await first.start();
    assert.equal(fake.toasts.length, 1);
    first.confirm([{ kind: "plugin", spec: "foo" }]);

    await build().start();

    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.equal(fake.kv.get(PENDING_KEY), null);
    assert.deepEqual([...port.calls], ["foo"]);
    assert.deepEqual(
      fake.toasts.map((t) => t.message),
      [TOAST_MESSAGE(1), PREPARED_TOAST],
    );
  });
});

test("after the prepared update is applied, the next start refreshes the stale snapshot without a manual refresh", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    const first = build();
    await first.start();
    first.confirm([{ kind: "plugin", spec: "foo" }]);
    await fake.disposeCallbacks[0]!();

    // The host reinstalls the fresh version into the cache on the next start.
    await installPackage(root, "foo", "2.0.0");

    const revived = build();
    await revived.start();

    const snapshot = revived.getSnapshot();
    assert.ok(snapshot);
    assert.equal(candidateBySpec(snapshot, "foo").installedVersion, "2.0.0");
    assert.equal(candidateBySpec(snapshot, "foo").updateAvailable, false);
    assert.deepEqual([...port.calls], ["foo", "foo"]);
  });
});

test("recovery runs before the cycle: the drained package is already gone when the cycle looks", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });

    build().confirm([{ kind: "plugin", spec: "foo" }]);

    const revived = build();
    await revived.start();

    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.equal(fake.kv.get(PENDING_KEY), null);
    const snapshot = revived.getSnapshot();
    assert.ok(snapshot);
    const foo = candidateBySpec(snapshot, "foo");
    assert.equal(foo.status, "unknown");
    assert.equal(foo.reason, "not in cache");
    assert.deepEqual([...port.calls], []);
    assert.deepEqual(fake.toasts.map((t) => t.message), [PREPARED_TOAST]);
  });
});

test("a cycle result cannot un-confirm: a manual check with updates keeps pending-restart", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });
    const model = build();

    model.confirm([{ kind: "plugin", spec: "foo" }]);
    assert.equal(model.state, "pending-restart");

    await model.runCheck();
    assert.equal(model.state, "pending-restart");
  });
});

test("re-confirming merges into the marker: earlier selections survive until consumed", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "bar", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "bar"] });
    const model = build();

    model.confirm([{ kind: "plugin", spec: "foo" }]);
    model.confirm([
      { kind: "plugin", spec: "bar" },
      { kind: "plugin", spec: "foo" },
    ]);

    assert.deepEqual(fake.kv.get(PENDING_KEY), [
      { kind: "plugin", spec: "foo" },
      { kind: "plugin", spec: "bar" },
    ]);
    assert.deepEqual(fake.toasts.map((t) => t.message), [PREPARED_TOAST, PREPARED_TOAST]);

    await fake.disposeCallbacks[0]!();
    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.ok(!existsSync(join(root, "bar@latest")));
    assert.equal(fake.kv.get(PENDING_KEY), null);
  });
});

test("pending never leaks: marker entries are not candidates and add no toasts", async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo"] });
    const model = build();

    await model.start();
    assert.deepEqual(fake.toasts.map((t) => t.message), [TOAST_MESSAGE(1)]);

    model.confirm([
      { kind: "plugin", spec: "foo" },
      { kind: "plugin", spec: "ghost" },
    ]);
    assert.deepEqual(fake.toasts.map((t) => t.message), [TOAST_MESSAGE(1), PREPARED_TOAST]);

    const result = await model.runCheck();
    assert.ok(!result.candidates.some((c) => c.spec === "ghost"));
    assert.deepEqual(fake.toasts.map((t) => t.message), [TOAST_MESSAGE(1), PREPARED_TOAST]);
  });
});

test("state machine: full circle idle → updates-available → pending-restart → cache-invalidated → idle", { skip: SKIP_AS_ROOT }, async () => {
  await withCacheRoot(async (root) => {
    await installPackage(root, "foo", "1.0.0");
    await installPackage(root, "baz", "1.0.0");
    const port = spyPort(async () => ({ version: "2.0.0" }));
    const { fake, build } = makeHarness(port.fetchLatest, root, { specs: ["foo", "baz"] });

    const model = build();
    assert.equal(model.state, "idle");

    await model.start();
    assert.equal(model.state, "updates-available");

    model.confirm([
      { kind: "plugin", spec: "foo" },
      { kind: "plugin", spec: "baz" },
    ]);
    assert.equal(model.state, "pending-restart");

    const doomed = join(root, "baz@latest");
    await chmod(doomed, 0o500);
    try {
      await fake.disposeCallbacks[0]!();
    } finally {
      await chmod(doomed, 0o700);
    }
    assert.ok(!existsSync(join(root, "foo@latest")));
    assert.ok(existsSync(doomed));
    assert.equal(model.state, "cache-invalidated");
    assert.deepEqual(fake.kv.get(PENDING_KEY), [{ kind: "plugin", spec: "baz" }]);

    const revived = build();
    await revived.start();
    assert.ok(!existsSync(doomed));
    assert.equal(fake.kv.get(PENDING_KEY), null);
    assert.equal(revived.state, "idle");
  });
});
