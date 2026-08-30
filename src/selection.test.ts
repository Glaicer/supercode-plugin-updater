import { strict as assert } from "node:assert";
import test from "node:test";
import { createSelection, isSelectable } from "./selection.ts";
import type { UpdateCandidate } from "./update-model.ts";

/**
 * Selection rules for the interactive screen (ticket 06). Pure store, no
 * renderer: the checkbox-able class is exactly the candidates the cycle
 * checked against the registry; pinned, unknown, and skipped are never
 * selectable — not by Space, not by `A`.
 */

function checked(kind: "plugin" | "tool", spec: string, update: boolean): UpdateCandidate {
  return {
    kind,
    spec,
    name: spec,
    status: "checked",
    installedVersion: "1.0.0",
    latestVersion: update ? "2.0.0" : "1.0.0",
    updateAvailable: update,
  };
}

function pinned(spec: string): UpdateCandidate {
  return { kind: "plugin", spec, name: spec, status: "pinned", pinnedVersion: "1.2.3" };
}

function unknown(spec: string): UpdateCandidate {
  return { kind: "plugin", spec, name: spec, status: "unknown", reason: "registry lookup failed" };
}

test("selectable is exactly the checked class, of either kind", () => {
  assert.equal(isSelectable(checked("plugin", "foo", true)), true);
  assert.equal(isSelectable(checked("tool", "pyright", false)), true);
  assert.equal(isSelectable(pinned("bar@1.2.3")), false);
  assert.equal(isSelectable(unknown("baz")), false);
});

test("space toggle flips one checked candidate; pinned and unknown cannot enter", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  const bar = pinned("bar@1.2.3");
  const baz = unknown("baz");

  selection.toggle(foo);
  assert.equal(selection.has(foo), true);
  selection.toggle(foo);
  assert.equal(selection.has(foo), false);

  selection.toggle(bar);
  selection.toggle(baz);
  assert.equal(selection.has(bar), false);
  assert.equal(selection.has(baz), false);
});

test("A selects every selectable candidate of both kinds, none besides", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  const tool = checked("tool", "pyright", false);
  const uptodate = checked("plugin", "qux", false);
  const bar = pinned("bar@1.2.3");
  const baz = unknown("baz");

  selection.selectAll([foo, bar, tool, baz, uptodate]);

  assert.equal(selection.has(foo), true);
  assert.equal(selection.has(tool), true);
  assert.equal(selection.has(uptodate), true);
  assert.equal(selection.has(bar), false);
  assert.equal(selection.has(baz), false);
});

test("A over a partially toggled list converges on all selectable", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  const tool = checked("tool", "pyright", true);
  selection.toggle(foo);
  selection.selectAll([foo, tool]);
  assert.equal(selection.has(foo), true);
  assert.equal(selection.has(tool), true);
});

test("selectedEntries maps to PendingInvalidationEntry in candidate order", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  const tool = checked("tool", "pyright", true);
  const bar = pinned("bar@1.2.3");
  selection.toggle(tool);
  selection.toggle(foo);
  selection.toggle(bar);

  assert.deepEqual(selection.selectedEntries([foo, bar, tool]), [
    { kind: "plugin", spec: "foo" },
    { kind: "tool", spec: "pyright" },
  ]);
});

test("the same spec marked under both kinds selects each kind's own entry", () => {
  const selection = createSelection();
  const plugin = checked("plugin", "prettier", true);
  const tool = checked("tool", "prettier", true);
  selection.toggle(plugin);
  selection.toggle(tool);
  assert.deepEqual(selection.selectedEntries([plugin, tool]), [
    { kind: "plugin", spec: "prettier" },
    { kind: "tool", spec: "prettier" },
  ]);
});

test("a selection stale after a refresh counts as empty and drops from entries", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  selection.toggle(foo);
  assert.equal(selection.isEmpty([foo]), false);

  // Refresh replaced the list: foo is gone, qux appeared.
  const qux = checked("plugin", "qux", true);
  assert.equal(selection.isEmpty([qux]), true);
  assert.deepEqual(selection.selectedEntries([qux]), []);
});

test("clear empties everything — the post-confirm reset", () => {
  const selection = createSelection();
  const foo = checked("plugin", "foo", true);
  selection.toggle(foo);
  selection.clear();
  assert.equal(selection.has(foo), false);
  assert.equal(selection.isEmpty([foo]), true);
});

test("empty universe: toggle, selectAll, entries, isEmpty all no-op", () => {
  const selection = createSelection();
  selection.selectAll([]);
  assert.deepEqual(selection.selectedEntries([]), []);
  assert.equal(selection.isEmpty([]), true);
});
