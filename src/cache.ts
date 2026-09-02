
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

// Relative XDG_CACHE_HOME values are invalid by specification.
export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "opencode", "packages");
}

export type PackageKind = "plugin" | "tool";

export interface PackageCache {
  has(name: string): boolean;
  /**
   * Missing or malformed manifests produce an unknown version rather than an
   * exception.
   */
  getInstalledVersion(name: string): string | undefined;
  hasTool(name: string): boolean;
  getInstalledToolVersion(name: string): string | undefined;
  /**
   * The target is guarded to remain strictly inside the cache root. Missing
   * directories are successful no-ops; other removal failures throw.
   */
  removeKeyDir(kind: PackageKind, name: string): void;
}

function pluginKeyDir(root: string, name: string): string {
  return join(root, `${name}@latest`);
}

function toolKeyDir(root: string, name: string): string {
  return join(root, name);
}

function guardedKeyDir(root: string, kind: PackageKind, name: string): string {
  const dir = kind === "plugin" ? pluginKeyDir(root, name) : toolKeyDir(root, name);
  const rel = relative(root, dir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`cache: ${JSON.stringify(name)} does not resolve to a key dir inside the cache root`);
  }
  return dir;
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
    removeKeyDir(kind, name) {
      rmSync(guardedKeyDir(root, kind, name), { recursive: true, force: true });
    },
  };
}
