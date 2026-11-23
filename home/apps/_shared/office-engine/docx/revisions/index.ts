/**
 * The engines behind `acceptRevisions` and `rejectRevisions`.
 *
 * A logical revision is a set of XML elements (see `RevisionGroup`). Each
 * element is resolved where it stands:
 *
 * | element                              | kept (accept ins, reject del)  | dropped (reject ins, accept del)      |
 * | ------------------------------------ | ------------------------------ | ------------------------------------- |
 * | `w:ins`/`w:del`/move around runs     | unwrapped                      | removed with its content              |
 * | the same on a paragraph mark         | mark removed                   | the paragraph joins the next one      |
 * | the same in `w:trPr`                 | mark removed                   | the row is removed                    |
 * | property change records              | record removed                 | old properties restored               |
 *
 * A move is an insertion (`w:moveTo`) and a deletion (`w:moveFrom`) that
 * are resolved together, with the range markers that name the move.
 */

import type { RevisionId } from "../../api/docx-model.js";
import type { ResolveRevisionsResult } from "../../api/docx-ops.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { beginChanges } from "../edit/changes.js";
import type { DocxEngines, DocxIndex, RevisionGroup } from "../internal.js";
import { Resolver } from "./resolver.js";

/** Passes over the document when resolving everything: revisions can hide behind others (two marks on one paragraph mark). */
const MAX_PASSES = 16;

function unknownRevision(id: unknown): OfficeError {
  return new OfficeError("stale_reference", "unknown revision id", { details: { revisionId: String(id) } });
}

/**
 * The groups named by `ids`, with the rest of every move: its other half,
 * and every other piece of it. An edit inside moved text splits it into
 * several revisions between one pair of range markers; half a move left
 * behind would have neither a partner nor its markers.
 */
function selectGroups(index: DocxIndex, ids: readonly RevisionId[]): RevisionGroup[] {
  const revisions = index.revisions;
  const chosen = new Map<RevisionId, RevisionGroup>();
  for (const id of ids) {
    const group = typeof id === "string" ? revisions.byId.get(id) : undefined;
    if (group === undefined) throw unknownRevision(id);
    chosen.set(group.revision.id, group);
  }
  const moveNames = new Set<string>();
  for (const group of [...chosen.values()]) {
    const kind = group.revision.kind;
    if (kind !== "moveFrom" && kind !== "moveTo") continue;
    if (group.moveName !== null) moveNames.add(group.moveName);
    const pair = group.revision.pairedWith;
    const other = pair === null ? undefined : revisions.byId.get(pair);
    if (other !== undefined) {
      chosen.set(other.revision.id, other);
      if (other.moveName !== null) moveNames.add(other.moveName);
    }
  }
  if (moveNames.size > 0) {
    for (const group of revisions.groups) {
      if (group.moveName !== null && moveNames.has(group.moveName)) chosen.set(group.revision.id, group);
    }
  }
  // In the order of `listRevisions`.
  return revisions.groups.filter((group) => chosen.has(group.revision.id));
}

function resolveRevisions(index: DocxIndex, ids: readonly RevisionId[] | "all", accept: boolean): ResolveRevisionsResult {
  if (ids !== "all" && !Array.isArray(ids)) throw new OfficeError("invalid_argument", 'ids must be an array or "all"');
  const everything = ids === "all";
  let groups = everything ? [...index.revisions.groups] : selectGroups(index, ids as readonly RevisionId[]);
  if (groups.length === 0) {
    return { resolvedIds: [], createdBlockIds: [], removedBlockIds: [], changedBlockIds: [], changedStoryIds: [] };
  }
  const snapshot = index.snapshot();
  const recorder = beginChanges(index);
  const resolvedIds: RevisionId[] = [];
  const touched = new Set<XmlElement>();
  try {
    for (let pass = 0; pass < MAX_PASSES && groups.length > 0; pass++) {
      const resolver = new Resolver(index, accept, touched);
      for (const group of groups) {
        if (!resolvedIds.includes(group.revision.id)) resolvedIds.push(group.revision.id);
        resolver.add(group);
      }
      resolver.run();
      if (everything) resolver.removeMoveMarkers();
      groups = everything ? [...index.revisions.groups] : [];
    }
    const changes = recorder.finish(touched);
    return { resolvedIds, ...changes };
  } catch (error) {
    index.restore(snapshot);
    throw error;
  }
}

export const acceptRevisions: NonNullable<DocxEngines["acceptRevisions"]> = (index, ids) => resolveRevisions(index, ids, true);

export const rejectRevisions: NonNullable<DocxEngines["rejectRevisions"]> = (index, ids) => resolveRevisions(index, ids, false);
