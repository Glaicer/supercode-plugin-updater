/**
 * checker — registry access contract and version comparison.
 *
 * Knows nothing about the TUI, the effective config, or the package cache.
 * The registry is reachable only through the injected `fetchLatest` port, so
 * tests run without network and the production port is a later ticket's wire.
 */

/** Successful `GET <registry>/<name>/latest` reduced to the one field we use. */
export interface Latest {
  version: string;
}

/**
 * Registry port: `latest` dist-tag lookup by package name. Any per-package
 * failure (404, network error, unparsable body) rejects — the caller decides
 * what a rejection means; this contract never returns a sentinel.
 */
export type FetchLatest = (name: string) => Promise<Latest>;

/** Prerelease/build suffixes are outside the game: the triple decides. */
export interface SemverTriple {
  major: number;
  minor: number;
  patch: number;
}

/**
 * semver-lite: parse the leading `major.minor.patch` triple of a version
 * string. Anything else (ranges, garbage, non-strings) has no triple and
 * yields `undefined` — callers map that to an `unknown` status, never to a
 * false comparison.
 */
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

/**
 * True when `latest` is strictly newer than `installed` by the
 * major/minor/patch triple; false when equal or older; `undefined` when
 * either side has no parsable triple.
 */
export function isUpdateAvailable(installed: unknown, latest: unknown): boolean | undefined {
  const installedTriple = parseTriple(installed);
  const latestTriple = parseTriple(latest);
  if (!installedTriple || !latestTriple) return undefined;
  return compareTriple(installedTriple, latestTriple) < 0;
}

/** Production registry. Tests inject a port instead — no network in tests. */
export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";

/**
 * Default `fetchLatest` over the npm registry: `GET <base>/<name>/latest`,
 * reduced to the `version` field. Scoped names are URL-encoded (`@scope/name`
 * → `@scope%2Fname`). Any non-2xx status, body, or missing version rejects —
 * per-package failures never leak past the caller's isolation. `fetchImpl`
 * exists so tests can feed frozen JSON fixtures through the real parsing
 * path without network.
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
