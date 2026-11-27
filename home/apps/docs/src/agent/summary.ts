/**
 * What an applied request changed, for the result card: one item per
 * proposed change (a replacement's deletion and insertion together), with
 * the block to jump to, and the comments it added.
 */

import { PREVIEW_CHARS } from "./constants";
import type { BlockId, CommentId, DocxDocument, Revision, RevisionId } from "./engine";
import type { ChangeSummaryItem, CommentSummaryItem } from "./types";

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** Summary items for the given revisions, in document order. Ids no longer pending are skipped. */
export function summariseChanges(doc: DocxDocument, revisionIds: readonly RevisionId[]): ChangeSummaryItem[] {
  const wanted = new Set(revisionIds);
  const revisions = doc.listRevisions().filter((revision) => wanted.has(revision.id));
  const byId = new Map<RevisionId, Revision>(revisions.map((revision) => [revision.id, revision]));
  const seen = new Set<RevisionId>();
  const items: ChangeSummaryItem[] = [];
  for (const revision of revisions) {
    if (seen.has(revision.id)) continue;
    seen.add(revision.id);
    const partner = revision.pairedWith !== null ? byId.get(revision.pairedWith) : undefined;
    if (partner !== undefined) seen.add(partner.id);
    const blockId = revision.blockIds[0] as BlockId;
    const ids = partner !== undefined ? [revision.id, partner.id] : [revision.id];
    if (revision.kind === "format") {
      items.push({ revisionIds: ids, kind: "format", blockId, range: revision.range, before: "", after: preview(revision.text) });
    } else if (revision.kind === "moveFrom" || revision.kind === "moveTo") {
      items.push({ revisionIds: ids, kind: "move", blockId, range: revision.range, before: preview(revision.text), after: "" });
    } else if (partner !== undefined) {
      const deleted = revision.kind === "delete" ? revision : partner;
      const inserted = revision.kind === "insert" ? revision : partner;
      items.push({ revisionIds: ids, kind: "replace", blockId, range: revision.range, before: preview(deleted.text), after: preview(inserted.text) });
    } else if (revision.kind === "delete") {
      items.push({ revisionIds: ids, kind: "delete", blockId, range: revision.range, before: preview(revision.text), after: "" });
    } else {
      items.push({ revisionIds: ids, kind: "insert", blockId, range: revision.range, before: "", after: preview(revision.text) });
    }
  }
  return items;
}

/** Summary items for the given comments, in document order. */
export function summariseComments(doc: DocxDocument, commentIds: readonly CommentId[]): CommentSummaryItem[] {
  const wanted = new Set(commentIds);
  return doc
    .listComments()
    .filter((comment) => wanted.has(comment.id))
    .map((comment) => ({
      commentId: comment.id,
      blockId: comment.range?.start.blockId ?? null,
      range: comment.range,
      text: preview(comment.text),
      anchorText: preview(comment.anchorText),
    }));
}

/** Revision ids of the list that are still pending in the document. */
export function pendingRevisionIds(doc: DocxDocument, revisionIds: readonly RevisionId[]): RevisionId[] {
  const pending = new Set(doc.listRevisions().map((revision) => revision.id));
  return revisionIds.filter((id) => pending.has(id));
}

/** One line per change for an owner-facing summary, e.g. `Replaced “30 days” with “45 days”`. */
export function describeChange(item: ChangeSummaryItem): string {
  switch (item.kind) {
    case "replace":
      return `Replaced “${item.before}” with “${item.after}”`;
    case "insert":
      return `Inserted “${item.after}”`;
    case "delete":
      return `Deleted “${item.before}”`;
    case "move":
      return `Moved “${item.before}”`;
    default:
      return `Formatting of “${item.after}”`;
  }
}
