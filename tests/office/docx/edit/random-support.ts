import type { DocxDocument } from "../../../../packages/office/src/api/docx.js";
import { markRevisions } from "../../../../packages/office/src/docx/edit/marks.js";
import { getDocxIndex } from "../../../../packages/office/src/docx/internal.js";

export { getDocxIndex };

/** Names of the tracked-change elements on the mark of a paragraph. */
export function markRevisionsForTest(doc: DocxDocument, blockId: string): string[] {
  const record = getDocxIndex(doc).block(blockId);
  return record === null ? [] : markRevisions(record.element).map((element) => element.name);
}
