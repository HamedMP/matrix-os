/**
 * Which runs a view shows, decided from the XML rather than from the one
 * revision mark a run carries in the view model. A deletion nested in
 * another author's insertion is marked `delete`, yet it is gone in the
 * `original` view too, because the insertion around it is. The paragraph
 * scan knows both (`context.inserted`, `context.deleted`), so runs are split
 * at the atoms that the view leaves out. The same holds for a paragraph mark
 * and a table row that carry an insertion and a deletion.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { InlineRun } from "../../api/docx-model.js";
import { isOfficeError } from "../../errors.js";
import { getDocxIndex } from "../model/document.js";
import type { DocxIndex } from "../model/doc-index.js";
import { type InlineAtom, atomInView, atomIndexAt, revisionsGoneInView } from "../model/inline.js";
import { rowRevisionElements } from "../model/revisions.js";
import { tableRows } from "../model/structure.js";
import { type RunFilter, goneInView, markRunFilter } from "./flatten.js";

function filterWithIndex(index: DocxIndex): RunFilter {
  const filter: RunFilter = (block, view) => {
    const record = index.block(block.id);
    if (record === null || record.type !== "paragraph") return markRunFilter(block, view);
    const scan = index.scan(record.element);
    const out: InlineRun[] = [];
    for (const run of block.runs) {
      const end = run.start + run.text.length;
      let position = run.start;
      let atomIndex = atomIndexAt(scan, position);
      let piece: InlineRun | null = null;
      while (position < end) {
        const atom = scan.atoms[atomIndex] as InlineAtom | undefined;
        // Past the scanned atoms (should not happen): trust the run's own mark.
        let atomEnd = atom === undefined ? end : Math.min(end, atom.start + atom.text.length);
        if (atomEnd <= position) atomEnd = end;
        const visible = atom === undefined ? markRunFilter({ ...block, runs: [run] }, view).length > 0 : atomInView(atom, view);
        if (visible) {
          const text = run.text.slice(position - run.start, atomEnd - run.start);
          if (piece === null) {
            piece = { ...run, start: position, text };
            out.push(piece);
          } else {
            piece.text += text;
          }
        } else {
          piece = null;
        }
        position = atomEnd;
        atomIndex++;
      }
    }
    return out;
  };
  // A mark or row that one author inserted and another deleted carries both revisions; the view model shows one.
  filter.markGone = (block, view) => {
    const record = index.block(block.id);
    if (record === null || record.type !== "paragraph") return goneInView(block.markRevision?.kind, view);
    return revisionsGoneInView(index.scan(record.element).marks, view);
  };
  filter.rowGone = (table, rowIndex, view) => {
    const record = index.block(table.id);
    const row = record === null || record.type !== "table" ? undefined : tableRows(record.element)[rowIndex];
    if (row === undefined) return goneInView(table.rows[rowIndex]?.revision?.kind, view);
    return revisionsGoneInView(rowRevisionElements(row), view);
  };
  return filter;
}

/** The run filter for a document: exact for handles of this engine, mark-based for anything else. */
export function runFilterFor(doc: DocxDocument): RunFilter {
  try {
    return filterWithIndex(getDocxIndex(doc));
  } catch (error) {
    if (isOfficeError(error) && error.code === "invalid_argument") return markRunFilter;
    throw error;
  }
}
