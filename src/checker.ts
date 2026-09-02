export interface Latest {
  version: string;
}

// Per-package failures reject; the model decides how to isolate them.
export type FetchLatest = (name: string) => Promise<Latest>;

export interface SemverTriple {
  major: number;
  minor: number;
  patch: number;
}

// Prerelease and build suffixes are intentionally ignored.
export function parseTriple(version: unknown): SemverTriple | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return { major, minor, patch };
}

function compareTriple(a: SemverTriple, b: SemverTriple): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(installed: unknown, latest: unknown): boolean | undefined {
  const installedTriple = parseTriple(installed);
  const latestTriple = parseTriple(latest);
  if (!installedTriple || !latestTriple) return undefined;
  return compareTriple(installedTriple, latestTriple) < 0;
}

export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";

/**
 * `fetchImpl` allows tests to exercise the production response parsing
 * without network access.
 */
export function createNpmRegistryPort(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): FetchLatest {
  const baseUrl = options.baseUrl ?? NPM_REGISTRY_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  return async (name) => {
    const response = await doFetch(`${baseUrl}/${encodeURIComponent(name)}/latest`);
    if (!response.ok) {
      throw new Error(`registry: ${name}/latest responded ${response.status}`);
    }
    const body: unknown = await response.json();
    const version = (body as { version?: unknown } | null)?.version;
    if (typeof version !== "string") {
      throw new Error(`registry: ${name}/latest has no version string`);
    }
    return { version };
  };
}
