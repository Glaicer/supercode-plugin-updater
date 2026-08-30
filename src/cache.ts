/**
 * cache — `PackageCache` adapter over the OpenCode package cache
 * (`~/.cache/opencode/packages`). The unstable cache layout lives only here.
 * Two key-dir shapes share one root:
 *
 * - Plugin resolver (`name@latest`): the resolver normalizes a bare spec to
 *   `name@latest` before install, so the key dir for a plugin `name` is
 *   `<root>/name@latest` (scoped names nest: `<root>/@scope/name@latest`).
 *   Older OpenCode generations left a sibling dir without the `@latest`
 *   suffix — it is never read.
 * - Managed Tools (bare name): `Npm.which` keys the dir by the raw package
 *   name with no `@latest` suffix — `<root>/<tool>` (verified against the
 *   host binary and the live cache). The installed version is read from the
 *   same manifest shape as plugins: `<key>/node_modules/<name>/package.json`.
 *
 * Knows nothing about the registry, the known tool set, or the effective
 * config.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Production cache root. `XDG_CACHE_HOME` is honored only when absolute;
 * observed layout is `<base>/opencode/packages`.
 */
export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "opencode", "packages");
}

export interface PackageCache {
  /** True when the plugin-resolver key dir (`<name>@latest`) exists. */
  has(name: string): boolean;
  /**
   * Installed version from `<key>/node_modules/<name>/package.json`. A missing
   * dir, missing/unreadable/unparsable manifest, or a non-string `version`
   * yields `undefined` — an unknown fact, never an exception.
   */
  getInstalledVersion(name: string): string | undefined;
  /** True when the managed-tool key dir (bare `<name>`) exists. */
  hasTool(name: string): boolean;
  /** Same contract as `getInstalledVersion`, over the tool key dir. */
  getInstalledToolVersion(name: string): string | undefined;
}

/** Plugin resolver key dir: the resolver appends `@latest` to bare specs. */
function pluginKeyDir(root: string, name: string): string {
  return join(root, `${name}@latest`);
}

/** Managed-tool key dir: `Npm.which` keys by the raw name, no suffix. */
function toolKeyDir(root: string, name: string): string {
  return join(root, name);
}

function manifestPath(dir: string, name: string): string {
  return join(dir, "node_modules", ...name.split("/"), "package.json");
}

function readInstalledVersion(dir: string, name: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath(dir, name), "utf8"));
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

export function createPackageCache(root: string): PackageCache {
  return {
    has(name: string): boolean {
      return existsSync(pluginKeyDir(root, name));
    },
    getInstalledVersion(name: string): string | undefined {
      return readInstalledVersion(pluginKeyDir(root, name), name);
    },
    hasTool(name: string): boolean {
      return existsSync(toolKeyDir(root, name));
    },
    getInstalledToolVersion(name: string): string | undefined {
      return readInstalledVersion(toolKeyDir(root, name), name);
    },
  };
}
