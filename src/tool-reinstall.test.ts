import { strict as assert } from "node:assert";
import test from "node:test";
import { createServerApply } from "./server-apply.ts";
import type { ServerRow } from "./server-updates.ts";
import {
  reconcilePendingTool,
  reinstallConfirmationMessage,
  toolPhaseLabel,
  validatedToolNames,
  type PendingTool,
} from "./tool-reinstall.ts";

function apply() {
  return createServerApply({
    list: async () => [],
    tuiTargets: async () => [],
    update: async () => {},
    runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
    location: () => "/project",
    checkedEnvironment: () => "",
    settle: async () => ({ read: false, absent: [], confirmed: [], unversioned: [] }),
  });
}

function toolRow(name: string, status: ServerRow["status"], installedVersion?: string): ServerRow {
  return {
    id: `tool:${name}`,
    runtime: "tool",
    spec: name,
    name,
    status,
    ...(installedVersion === undefined ? {} : { installedVersion }),
  };
}

test("a managed tool with a confirmed update is selectable; a current one is not", () => {
  const a = apply();
  const updatable = toolRow("prettier", "update", "3.0.0");
  const current = toolRow("oxfmt", "current", "1.0.0");
  a.toggle(updatable);
  assert.deepEqual([...a.selectedToolRows([updatable, current])].map((row) => row.id), ["tool:prettier"]);
  a.toggle(current);
  assert.deepEqual([...a.selectedToolRows([updatable, current])].map((row) => row.id), ["tool:prettier"]);
  // The tool selection never leaks into the plugin update path.
  assert.deepEqual(a.selectedPluginRows([updatable, current]), []);
});

test("the reinstall confirmation warns about the shared server restart and defers install to next use", () => {
  const message = reinstallConfirmationMessage([
    { name: "prettier", installedVersion: "3.0.0", latestVersion: "3.2.0" },
  ]);
  assert.match(message, /prettier 3\.0\.0 → 3\.2\.0/);
  assert.match(message, /restarts the shared OpenCode server/i);
  assert.match(message, /disconnects connected windows/i);
  assert.match(message, /interrupts agents' current work/i);
  assert.match(message, /stops server terminals/i);
  assert.match(message, /on next use — not immediately/i);
});

test("an invalidated tool reads pending until the cache actually shows a reinstall", () => {
  const entry: PendingTool = { name: "prettier", previousVersion: "3.0.0", at: 1_000 };
  // Cache gone: awaiting OpenCode's own install on next use — never "updated".
  assert.equal(reconcilePendingTool(entry, undefined, 2_000).phase, "pending");
  assert.equal(toolPhaseLabel(reconcilePendingTool(entry, undefined, 2_000)), "awaiting reinstallation");
  // Same version back in the cache within the window is still in flight.
  assert.equal(reconcilePendingTool(entry, "3.0.0", 2_000).phase, "reinstalling");
  // Same version after the window means the invalidation never took effect.
  assert.equal(reconcilePendingTool(entry, "3.0.0", 2_000 + 60_000).phase, "invalidation-failed");
  // Only a version different from the pre-operation one is a confirmed reinstall.
  const reinstalled = reconcilePendingTool(entry, "3.2.0", 2_000);
  assert.equal(reinstalled.phase, "reinstalled");
  assert.equal(toolPhaseLabel(reinstalled), "reinstalled · now 3.2.0");
});

test("reinstallation only ever targets the supported managed tools", () => {
  assert.deepEqual(validatedToolNames(["prettier", "oxfmt", "@biomejs/biome"]), [
    "prettier",
    "oxfmt",
    "@biomejs/biome",
  ]);
  // Anything else — a plugin, another package, a path — is dropped.
  assert.deepEqual(validatedToolNames(["prettier", "@glaicer/supercode-plugin-updater", "rm", "/etc"]), ["prettier"]);
});
