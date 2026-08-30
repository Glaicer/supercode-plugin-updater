/**
 * plugins — taxonomy of effective-config plugin specs into the three canonical
 * classes. Pure parsing: no TUI, no cache, no registry.
 *
 * - `foo`, `foo@latest` (also scoped `@scope/name[@latest]`) — Floating Spec.
 * - `foo@1.2.3` — Pinned Spec (exact version; registry is never asked).
 * - local paths, `file:`, `git+`, other URLs, semver ranges, other dist-tags —
 *   Unsupported, carried with a human-readable reason for the skipped group.
 */

export type PluginSpecClassification =
  | { kind: "floating"; spec: string; name: string }
  | { kind: "pinned"; spec: string; name: string; version: string }
  | { kind: "unsupported"; spec: string; reason: string };

/** Exact version pin: triple with optional prerelease/build suffix. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/;
/** `https://`, `ssh://`, … — after the `git+` prefix has been ruled out. */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Bare-word version part that is not the `latest` dist-tag. */
const OTHER_DIST_TAG = /^[A-Za-z][\w.-]*$/;

function unsupported(spec: string, reason: string): PluginSpecClassification {
  return { kind: "unsupported", spec, reason };
}

interface SplitSpec {
  name: string;
  /** `undefined` when the spec has no version part at all; `""` for a bare trailing `@`. */
  version: string | undefined;
}

/** Splits `[@scope/]name[@version]`. */
function splitSpec(spec: string): SplitSpec | undefined {
  let nameEnd = spec.length;
  let versionStart = -1;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return undefined;
    const at = spec.indexOf("@", slash + 1);
    if (at !== -1) {
      nameEnd = at;
      versionStart = at + 1;
    }
  } else {
    const at = spec.indexOf("@");
    if (at !== -1) {
      nameEnd = at;
      versionStart = at + 1;
    }
  }
  const name = spec.slice(0, nameEnd);
  if (!name) return undefined;
  // Bare names never contain `/`; scoped names are exactly `@scope/name`.
  if (name.startsWith("@")) {
    const rest = name.slice(1);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash !== rest.lastIndexOf("/")) return undefined;
  } else if (name.includes("/")) {
    return undefined;
  }
  return { name, version: versionStart === -1 ? undefined : spec.slice(versionStart) };
}

export function classifyPluginSpec(spec: string): PluginSpecClassification {
  if (spec.startsWith(".") || spec.startsWith("/")) return unsupported(spec, "local path");
  if (/^[A-Za-z]:[\\/]/.test(spec)) return unsupported(spec, "local path");
  if (spec.startsWith("file:")) return unsupported(spec, "file path");
  if (spec.startsWith("git+")) return unsupported(spec, "git URL");
  if (SCHEME_URL.test(spec)) return unsupported(spec, "URL spec");

  const split = splitSpec(spec);
  if (!split) return unsupported(spec, "invalid spec");
  const { name, version } = split;

  if (version === undefined || version === "latest") {
    // `foo` and `foo@latest` are the same Floating Spec.
    return { kind: "floating", spec, name };
  }
  if (version === "") {
    // `foo@` is the range `*` in npm semantics — not the floating form.
    return unsupported(spec, "semver range");
  }
  if (EXACT_VERSION.test(version)) return { kind: "pinned", spec, name, version };
  if (OTHER_DIST_TAG.test(version)) return unsupported(spec, "dist-tag");
  return unsupported(spec, "semver range");
}
