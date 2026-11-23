/**
 * Which runs a view shows, decided from the XML rather than from the one
 * revision mark a run carries in the view model. A deletion nested in
 * another author's insertion is marked `delete`, yet it is gone in the
 * `original` view too, because the insertion around it is. The paragraph
 * scan knows both (`context.inserted`, `context.deleted`), so runs are split
 * at the atoms that the view leaves out. The same holds for a paragraph mark
 * and a table row that carry an insertion and a deletion, and for the cells
 * of a tracked column, which the view model does not mark.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { InlineRun, TableBlock } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { isOfficeError } from "../../errors.js";
import { getDocxIndex } from "../model/document.js";
import type { DocxIndex } from "../model/doc-index.js";
import { type InlineAtom, atomInView, atomIndexAt, revisionsGoneInView } from "../model/inline.js";
import { rowCells, tableRows } from "../model/structure.js";
import { cellGoneInView, rowGoneInView } from "../model/table-revisions.js";
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
  // The rows of the table being written, listed once: a table is asked about each of its rows in turn.
  let listed: { id: string; rows: readonly XmlElement[] } | null = null;
  const rowsOf = (table: TableBlock): readonly XmlElement[] => {
    if (listed === null || listed.id !== table.id) {
      const record = index.block(table.id);
      listed = { id: table.id, rows: record === null || record.type !== "table" ? [] : tableRows(record.element) };
    }
    return listed.rows;
  };
  filter.rowGone = (table, rowIndex, view) => {
    const row = rowsOf(table)[rowIndex];
    if (row === undefined) return goneInView(table.rows[rowIndex]?.revision?.kind, view);
    return rowGoneInView(row, view);
  };
  // A tracked cell has no mark in the view model at all: only the document says which cells a view keeps.
  filter.cellsGone = (table, rowIndex, view) => {
    const row = rowsOf(table)[rowIndex];
    if (row === undefined || view === "markup") return null;
    let gone: boolean[] | null = null;
    rowCells(row).forEach((cell, cellIndex) => {
      if (cellGoneInView(cell, view)) (gone ??= [])[cellIndex] = true;
    });
    return gone;
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
