/** The summary of a comparison: its revisions counted by kind and classified. */

import type { DocxDocument } from "../../api/docx.js";
import type { RevisionKind } from "../../api/docx-model.js";
import type { BuildCounters, CompareChange, CompareSummary } from "./types.js";

export function summarise(document: DocxDocument, counters: BuildCounters): CompareSummary {
  const counts: Record<RevisionKind, number> = { insert: 0, delete: 0, moveFrom: 0, moveTo: 0, format: 0 };
  const changes: CompareChange[] = [];
  let substantive = 0;
  let formattingOnly = 0;
  for (const revision of document.listRevisions()) {
    counts[revision.kind] += 1;
    const classification = revision.kind === "format" ? "formatting" : "substantive";
    if (classification === "formatting") formattingOnly += 1;
    else substantive += 1;
    changes.push({
      revisionId: revision.id,
      kind: revision.kind,
      scope: revision.scope,
      classification,
      storyId: revision.storyId,
      blockIds: revision.blockIds,
      text: revision.text,
      pairedWith: revision.pairedWith,
    });
  }
  return {
    identical: changes.length === 0,
    total: changes.length,
    counts,
    substantive,
    formattingOnly,
    paragraphs: {
      inserted: counters.insertedParagraphs,
      deleted: counters.deletedParagraphs,
      moved: counters.movedParagraphs,
    },
    tableRows: { inserted: counters.insertedRows, deleted: counters.deletedRows },
    changes,
  };
}
