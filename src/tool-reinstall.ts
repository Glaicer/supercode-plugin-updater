import { SUPPORTED_MANAGED_TOOLS } from "./managed-tools.ts";

/**
 * A managed tool the user asked to reinstall. `previousVersion` is the version
 * in the cache before the operation; it is what tells "still the old install"
 * (invalidation failed) apart from "a fresh install appeared" (reinstalled).
 */
export interface PendingTool {
  name: string;
  previousVersion?: string;
  /** Epoch ms the operation was confirmed; anchors the in-flight window. */
  at: number;
}

export type ToolReinstallPhase = "reinstalling" | "pending" | "reinstalled" | "invalidation-failed";

export interface ToolReinstallOutcome {
  phase: ToolReinstallPhase;
  /** The version currently in the cache, when there is one. */
  version?: string;
}

/** How long a same-version cache is still read as "in flight" rather than failed. */
export const REINSTALL_WINDOW_MS = 60_000;

/**
 * Reconcile one pending tool against the version that is actually in the cache
 * right now. The cache is the only authority: an invalidated tool reports
 * `pending` until OpenCode installs it again on next use, and only a version
 * different from the pre-operation one counts as a confirmed reinstall — never
 * "updated" on the strength of the invalidation alone.
 */
export function reconcilePendingTool(
  entry: PendingTool,
  currentVersion: string | undefined,
  now: number,
  windowMs: number = REINSTALL_WINDOW_MS,
): ToolReinstallOutcome {
  if (currentVersion === undefined) return { phase: "pending" };
  if (currentVersion !== entry.previousVersion) return { phase: "reinstalled", version: currentVersion };
  return now - entry.at < windowMs
    ? { phase: "reinstalling", version: currentVersion }
    : { phase: "invalidation-failed", version: currentVersion };
}

/**
 * Reinstallation only ever targets the supported formatters. Any other name is
 * dropped so a bad selection can never widen the removal beyond the managed
 * tool cache.
 */
export function validatedToolNames(names: readonly string[]): string[] {
  return names.filter((name) => (SUPPORTED_MANAGED_TOOLS as readonly string[]).includes(name));
}

export interface ReinstallToolLine {
  name: string;
  installedVersion?: string;
  latestVersion?: string;
}

/**
 * The confirmation for the reinstall action. It must say what a restart of the
 * shared server does to everything attached to it, and must not promise that
 * the tools are downloaded at startup — OpenCode installs them on next use.
 */
export function reinstallConfirmationMessage(tools: readonly ReinstallToolLine[]): string {
  const lines = tools.map((tool) => {
    const pair =
      tool.installedVersion !== undefined && tool.latestVersion !== undefined
        ? ` ${tool.installedVersion} → ${tool.latestVersion}`
        : tool.installedVersion !== undefined
          ? ` ${tool.installedVersion}`
          : "";
    return `· ${tool.name}${pair}`;
  });
  return [
    ...lines,
    "",
    "Reinstalling managed tools restarts the shared OpenCode server. This disconnects connected windows, interrupts agents' current work, and stops server terminals.",
    "OpenCode installs the tools again on next use — not immediately when the server starts. Until then they show as awaiting reinstallation.",
  ].join("\n");
}

export function toolPhaseLabel(outcome: ToolReinstallOutcome): string {
  switch (outcome.phase) {
    case "reinstalling":
      return "reinstalling…";
    case "pending":
      return "awaiting reinstallation";
    case "reinstalled":
      return `reinstalled · now ${outcome.version ?? "unknown"}`;
    case "invalidation-failed":
      return `invalidation failed · still ${outcome.version ?? "unknown"}`;
  }
}
