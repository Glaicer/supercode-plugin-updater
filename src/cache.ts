/**
 * cache — `PackageCache` adapter over the OpenCode package cache
 * (`~/.cache/opencode/packages`). The unstable cache layout lives only here:
 * the current resolver normalizes a bare name to `name@latest` before install,
 * so the key dir for a package `name` is `<root>/name@latest` (scoped names
 * nest: `<root>/@scope/name@latest`). Older OpenCode generations left a
 * sibling dir without the `@latest` suffix — it is never read.
 *
 * Knows nothing about the registry or the effective config.
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
  /** True when the current-resolver key dir (`<name>@latest`) exists. */
  has(name: string): boolean;
  /**
   * Installed version from `<key>/node_modules/<name>/package.json`. A missing
   * dir, missing/unreadable/unparsable manifest, or a non-string `version`
   * yields `undefined` — an unknown fact, never an exception.
   */
  getInstalledVersion(name: string): string | undefined;
}

function keyDir(root: string, name: string): string {
  return join(root, `${name}@latest`);
}

function manifestPath(root: string, name: string): string {
  return join(keyDir(root, name), "node_modules", ...name.split("/"), "package.json");
}

export function createPackageCache(root: string): PackageCache {
  return {
    has(name: string): boolean {
      return existsSync(keyDir(root, name));
    },
    getInstalledVersion(name: string): string | undefined {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath(root, name), "utf8"));
        const version = (parsed as { version?: unknown } | null)?.version;
        return typeof version === "string" ? version : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
