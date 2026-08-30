import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@opencode-ai/sdk/v2";
import { createNpmRegistryPort, type FetchLatest } from "./checker.ts";
import { REGISTRY_CONCURRENCY, REGISTRY_TIMEOUT_MS, createUpdateModel, type CheckResult, type UpdateCandidate } from "./update-model.ts";
import { createFakeTuiApi } from "./fake-tui-api.ts";
import { MANAGED_TOOLS } from "./tools.ts";

/**
 * Every test runs the single seam — the Update Model under a fake
 * TuiPluginApi — against a REAL tmpdir package cache. No network: the
 * registry is always an injected port. Assertions read what the model emits
 * for rendering, never internals (spec: Testing Decisions).
 */

async function withCacheRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "plugin-updater-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes `<key>/node_modules/<name>/package.json` with raw text. */
async function writeNodeModulesManifest(key: string, name: string, content: string): Promise<void> {
  const dir = join(key, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), content);
}

/** Installs the CURRENT plugin generation: `<root>/<name>@latest/node_modules/<name>`. */
async function installPackage(
  root: string,
  name: string,
  version: string,
  manifest?: object,
): Promise<void> {
  await writeCacheManifest(root, name, JSON.stringify(manifest ?? { name, version }));
}

/** Writes the cache manifest of the current plugin generation as raw text. */
async function writeCacheManifest(
  root: string,
  name: string,
  content: string,
): Promise<void> {
  await writeNodeModulesManifest(join(root, `${name}@latest`), name, content);
}

/** Installs a LEGACY plugin generation dir without the `@latest` key suffix. */
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

function makeModel(
  specs: string[],
  port: FetchLatest,
  cacheRoot: string,
  options?: { timeoutMs?: number; concurrency?: number },
): { runCheck(): Promise<CheckResult> } {
  const fake = createFakeTuiApi({ plugin: specs } as Partial<Config>);
  return createUpdateModel(fake.api, {
    fetchLatest: port,
    cacheRoot,
    ...options,
  });
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

    // Floating: checked with the version pair and flag.
    const foo = candidateBySpec(result, "foo");
    assert.equal(foo.status, "checked");
    assert.equal(foo.installedVersion, "1.0.0");
    assert.equal(foo.latestVersion, "2.0.0");
    assert.equal(foo.updateAvailable, true);

    // Pinned: info-only, the badge version comes from the spec itself.
    const bar = candidateBySpec(result, "bar@1.2.3");
    assert.equal(bar.status, "pinned");
    assert.equal(bar.pinnedVersion, "1.2.3");
    assert.equal(bar.latestVersion, undefined);
    assert.equal(bar.updateAvailable, undefined);

    // Unsupported: skipped with a reason, absent from candidates.
    assert.deepEqual(result.skipped, [
      { kind: "plugin", spec: "./local-plugin", reason: "local path" },
      { kind: "plugin", spec: "file:./local.tgz", reason: "file path" },
      { kind: "plugin", spec: "https://example.com/x.tgz", reason: "URL spec" },
      { kind: "plugin", spec: "git+https://example.com/x.git", reason: "git URL" },
    ]);
    for (const spec of ["./local-plugin", "file:./local.tgz", "https://example.com/x.tgz", "git+https://example.com/x.git"]) {
      assert.ok(!result.candidates.some((c) => c.spec === spec), spec);
    }

    // The port spy confirms zero requests beyond the single floating spec.
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
    // Dir exists but no package.json at all.
    await mkdir(join(root, "no-manifest@latest", "node_modules", "no-manifest"), { recursive: true });
    // Unparsable manifest.
    await writeCacheManifest(root, "garbage", "{not json");
    // Manifest without a string version.
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
    // The dirs exist, so the registry was still asked for every one of them.
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
    // The real default port parses frozen JSON fixtures — no network.
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

test("default registry timeout is ~5s", () => {
  assert.equal(REGISTRY_TIMEOUT_MS, 5000);
});

/**
 * Managed Tools fixtures: the Npm.which install path keys the cache dir by
 * the bare name — `<root>/<tool>/node_modules/<tool>/package.json` — with no
 * `@latest` suffix (plugin resolver dirs are never reused for tools).
 */
async function installTool(root: string, name: string, version: string, manifest?: object): Promise<void> {
  await writeToolManifest(root, name, JSON.stringify(manifest ?? { name, version }));
}

/** Writes the manifest of a managed tool as raw text. */
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
    // Foreign cache content: a git-spec dependency and an unknown package —
    // neither belongs to the managed set, so neither is checked nor listed.
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

    // Checked path: installed→latest pair with the update flag.
    const pyright = candidateBySpec(result, "pyright");
    assert.equal(pyright.kind, "tool");
    assert.equal(pyright.status, "checked");
    assert.equal(pyright.installedVersion, "1.1.411");
    assert.equal(pyright.latestVersion, "9.9.9");
    assert.equal(pyright.updateAvailable, true);

    // Registry failure isolates to this candidate's unknown.
    const bash = candidateBySpec(result, "bash-language-server");
    assert.equal(bash.kind, "tool");
    assert.equal(bash.status, "unknown");
    assert.equal(bash.reason, "registry lookup failed");
    assert.equal(bash.updateAvailable, undefined);

    // Broken cache manifest → unknown, same as for plugins.
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
