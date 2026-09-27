import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTuiPackagePort } from "./tui-packages.ts";

function makeRoot(): { root: string; configDir: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tui-packages-"));
  const configDir = join(root, "config", "opencode");
  const cacheDir = join(root, "cache", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  return { root, configDir, cacheDir };
}

function installGeneration(cacheDir: string, name: string, spec: string, version: string, exports?: unknown): string {
  const directory = join(cacheDir, "npm", `${name}@${spec}`, "123", "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify(exports === undefined ? { name, version } : { name, version, exports }),
  );
  return directory;
}

test("cliTargets reads string and object entries, drops directives, and deduplicates", () => {
  const { root, configDir, cacheDir } = makeRoot();
  writeFileSync(
    join(configDir, "cli.json"),
    JSON.stringify({
      plugins: ["a-pkg", { package: "b-pkg", options: {} }, "-hidden", "*", "scope.*", "opencode.internal", "a-pkg", "/local/plugin"],
    }),
  );
  const port = createTuiPackagePort({ configDir, cacheDir });
  assert.deepEqual(port.cliTargets(), ["a-pkg", "b-pkg", "/local/plugin"]);
  rmSync(root, { recursive: true, force: true });
});

test("a missing or unparsable cli.json contributes no targets", () => {
  const { root, configDir, cacheDir } = makeRoot();
  const port = createTuiPackagePort({ configDir, cacheDir });
  assert.deepEqual(port.cliTargets(), []);
  writeFileSync(join(configDir, "cli.json"), "{ plugins: [ // jsonc");
  assert.deepEqual(port.cliTargets(), []);
  rmSync(root, { recursive: true, force: true });
});

test("installedVersion reads the newest generation and ignores unparsable manifests", () => {
  const { root, configDir, cacheDir } = makeRoot();
  installGeneration(cacheDir, "a-pkg", "latest", "1.0.0");
  installGeneration(cacheDir, "a-pkg", "latest", "1.2.0");
  const port = createTuiPackagePort({ configDir, cacheDir });
  assert.equal(port.installedVersion("a-pkg"), "1.2.0");
  assert.equal(port.installedVersion("a-pkg@1.0.0"), undefined);
  installGeneration(cacheDir, "a-pkg", "1.0.0", "1.0.0");
  assert.equal(port.installedVersion("a-pkg@1.0.0"), "1.0.0");

  installGeneration(cacheDir, "broken", "latest", "9.9.9");
  writeFileSync(join(cacheDir, "npm/broken@latest/123/node_modules/broken/package.json"), "{");
  assert.equal(port.installedVersion("broken"), undefined);
  assert.equal(port.installedVersion("never-installed"), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("installedVersion resolves scoped package layouts", () => {
  const { root, configDir, cacheDir } = makeRoot();
  const directory = join(cacheDir, "npm", "@scope/pkg@latest", "7", "node_modules", "@scope", "pkg");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "2.0.0" }));
  const port = createTuiPackagePort({ configDir, cacheDir });
  assert.equal(port.installedVersion("@scope/pkg"), "2.0.0");
  rmSync(root, { recursive: true, force: true });
});

test("exposesTui follows the exports map and the legacy file layout", () => {
  const { root, configDir, cacheDir } = makeRoot();
  installGeneration(cacheDir, "with-exports", "latest", "1.0.0", { "./tui": "./tui.js" });
  installGeneration(cacheDir, "without-exports", "latest", "1.0.0", { ".": "./index.js" });
  installGeneration(cacheDir, "legacy", "latest", "1.0.0");
  const port = createTuiPackagePort({ configDir, cacheDir });
  assert.equal(port.exposesTui("with-exports"), true);
  assert.equal(port.exposesTui("without-exports"), false);
  assert.equal(port.exposesTui("legacy"), false);
  writeFileSync(join(cacheDir, "npm/legacy@latest/123/node_modules/legacy/tui.js"), "export default {};");
  assert.equal(port.exposesTui("legacy"), true);
  assert.equal(port.exposesTui("not-installed"), false);
  rmSync(root, { recursive: true, force: true });
});
