export type PluginSpecClassification =
  | { kind: "floating"; spec: string; name: string }
  | { kind: "pinned"; spec: string; name: string; version: string }
  | { kind: "unsupported"; spec: string; reason: string };

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const OTHER_DIST_TAG = /^[A-Za-z][\w.-]*$/;

function unsupported(spec: string, reason: string): PluginSpecClassification {
  return { kind: "unsupported", spec, reason };
}

interface SplitSpec {
  name: string;
  version: string | undefined;
}

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
    return { kind: "floating", spec, name };
  }
  if (version === "") {
    // npm treats a trailing @ as the wildcard range, not the latest tag.
    return unsupported(spec, "semver range");
  }
  if (EXACT_VERSION.test(version)) return { kind: "pinned", spec, name, version };
  if (OTHER_DIST_TAG.test(version)) return unsupported(spec, "dist-tag");
  return unsupported(spec, "semver range");
}
