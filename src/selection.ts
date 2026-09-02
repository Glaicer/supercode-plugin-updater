import type { PendingInvalidationEntry as PendingEntry, UpdateCandidate } from "./update-model.ts";

export type { PendingEntry };

export function isSelectable(candidate: UpdateCandidate): boolean {
  return candidate.status === "checked";
}

export interface Selection {
  toggle(candidate: UpdateCandidate): void;
  selectAll(candidates: readonly UpdateCandidate[]): void;
  clear(): void;
  has(candidate: UpdateCandidate): boolean;
  selectedEntries(candidates: readonly UpdateCandidate[]): PendingEntry[];
  isEmpty(candidates: readonly UpdateCandidate[]): boolean;
}

export function createSelection(): Selection {
  // Object identity makes selections from a replaced candidate list stale.
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
