/**
 * Selection store for the interactive `/plugin-updates` screen (ticket 06).
 * Pure state, no renderer — the tested seam of the interactivity ticket,
 * mirroring how the Update Model is the tested seam of the check logic.
 *
 * The checkbox-able class is exactly the candidates the cycle checked
 * against the registry (`status: "checked"`), Floating plugins and Managed
 * Tools alike. Pinned (info-only badge), unknown (status string), and
 * skipped specs never enter the selection — not by Space, not by `A`
 * (US 11, 12, 13). Identity is the candidate object itself: a refresh
 * replaces the list, so a pre-refresh selection that no longer matches the
 * fresh candidates simply counts as unselected.
 */
import type { PendingInvalidationEntry as PendingEntry, UpdateCandidate } from "./update-model.ts";

export type { PendingEntry };

/** Only checked candidates (of either kind) can be toggled or bulk-selected. */
export function isSelectable(candidate: UpdateCandidate): boolean {
  return candidate.status === "checked";
}

export interface Selection {
  /** Flip one candidate; a non-selectable candidate is ignored. */
  toggle(candidate: UpdateCandidate): void;
  /** Select every selectable candidate of the list; others stay excluded. */
  selectAll(candidates: readonly UpdateCandidate[]): void;
  /** Unselect everything (post-confirm reset). */
  clear(): void;
  /** Is this candidate currently in the selection? */
  has(candidate: UpdateCandidate): boolean;
  /** The selection as Pending Invalidation entries, in the list's order. */
  selectedEntries(candidates: readonly UpdateCandidate[]): PendingEntry[];
  /** True when nothing selectable is currently marked. */
  isEmpty(candidates: readonly UpdateCandidate[]): boolean;
}

export function createSelection(): Selection {
  const marked = new Set<UpdateCandidate>();

  return {
    toggle(candidate) {
      if (!isSelectable(candidate)) return;
      if (marked.has(candidate)) {
        marked.delete(candidate);
      } else {
        marked.add(candidate);
      }
    },
    selectAll(candidates) {
      for (const candidate of candidates) {
        if (isSelectable(candidate)) marked.add(candidate);
      }
    },
    clear() {
      marked.clear();
    },
    has(candidate) {
      return marked.has(candidate);
    },
    selectedEntries(candidates) {
      const entries: PendingEntry[] = [];
      for (const candidate of candidates) {
        if (marked.has(candidate)) {
          entries.push({ kind: candidate.kind, spec: candidate.spec });
        }
      }
      return entries;
    },
    isEmpty(candidates) {
      return this.selectedEntries(candidates).length === 0;
    },
  };
}
