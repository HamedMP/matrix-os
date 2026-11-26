/** Helpers for `DocumentChange`: an empty one, and the union of two that happened in a row. */

import type { DocumentChange, DocumentChangeKind } from "./types";

export function emptyChange(kind: DocumentChangeKind, origin: string | null): DocumentChange {
  return {
    kind,
    full: false,
    changedBlockIds: [],
    createdBlockIds: [],
    removedBlockIds: [],
    changedStoryIds: [],
    revisionIds: [],
    origin,
    selection: null,
    selectionLost: false,
  };
}

function union<T>(first: readonly T[], second: readonly T[]): T[] {
  return [...new Set([...first, ...second])];
}

/**
 * The change that describes `first` followed by `second`. A block created and
 * removed again is in neither list; a created or removed block is not also
 * listed as changed.
 */
export function mergeChange(first: DocumentChange, second: DocumentChange): DocumentChange {
  const removedSecond = new Set(second.removedBlockIds);
  const createdThenRemoved = new Set(first.createdBlockIds.filter((id) => removedSecond.has(id)));
  const created = union(first.createdBlockIds, second.createdBlockIds).filter((id) => !createdThenRemoved.has(id));
  const removed = union(first.removedBlockIds, second.removedBlockIds).filter((id) => !createdThenRemoved.has(id));
  const gone = new Set([...created, ...removed, ...createdThenRemoved]);
  return {
    kind: first.kind === second.kind ? first.kind : "edit",
    full: first.full || second.full,
    changedBlockIds: union(first.changedBlockIds, second.changedBlockIds).filter((id) => !gone.has(id)),
    createdBlockIds: created,
    removedBlockIds: removed,
    changedStoryIds: union(first.changedStoryIds, second.changedStoryIds),
    revisionIds: union(first.revisionIds, second.revisionIds),
    origin: second.origin ?? first.origin,
    selection: second.selection,
    selectionLost: second.selectionLost,
  };
}
