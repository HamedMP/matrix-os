/**
 * Which runs a view shows, decided from the XML rather than from the one
 * revision mark a run carries in the view model. A deletion nested in
 * another author's insertion is marked `delete`, yet it is gone in the
 * `original` view too, because the insertion around it is. The paragraph
 * scan knows both (`context.inserted`, `context.deleted`), so runs are split
 * at the atoms that the view leaves out. The same holds for a paragraph mark
 * and a table row that carry an insertion and a deletion, and for the cells
 * of a tracked column, which the view model does not mark.
 *
 * The view model also shows current formatting and numbering counted over
 * every paragraph. In `original` the formatting is the one rejecting would
 * restore (the old properties of `w:rPrChange` and `w:pPrChange`), and in
 * both views a numbering label is counted among the paragraphs the view
 * keeps, so a deleted or inserted item does not take a number.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { BlockId, DocxTextView, InlineRun, NumberingLabel, ParagraphBlock, RunFormat, TableBlock } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { isOfficeError } from "../../errors.js";
import { getDocxIndex } from "../model/document.js";
import type { DocxIndex } from "../model/doc-index.js";
import { type InlineAtom, atomInView, atomIndexAt, revisionsGoneInView } from "../model/inline.js";
import { firstChild } from "../model/names.js";
import { type NumberedParagraph, computeNumberingLabels } from "../model/numbering.js";
import { RUN_FORMAT_KEYS } from "../model/props.js";
import { type ResolvedParagraph, tableStyleIdOf } from "../model/resolve.js";
import { type BlockRecord, rowCells, tableRows } from "../model/structure.js";
import { cellGoneInView, rowGoneInView } from "../model/table-revisions.js";
import { buildStory } from "../model/view.js";
import { type FlatBlock, type RunFilter, flattenBlocks, goneInView, markRunFilter } from "./flatten.js";

/** The properties a change record holds: what rejecting it puts back. */
function oldProperties(change: XmlElement | null): XmlElement | null {
  return change?.children.find((node): node is XmlElement => node.kind === "element") ?? null;
}

function sameFormat(a: RunFormat, b: RunFormat): boolean {
  for (const key of RUN_FORMAT_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

function formatOf(run: InlineRun): RunFormat {
  const format = {} as Record<string, unknown>;
  for (const key of RUN_FORMAT_KEYS) format[key] = run[key];
  return format as unknown as RunFormat;
}

/** Formatting and numbering as `final` and `original` show them. */
class ViewProperties {
  private readonly paragraphs = { final: new Map<XmlElement, ResolvedParagraph>(), original: new Map<XmlElement, ResolvedParagraph>() };
  /** Per export: bounded by the runs of the document, which the open limits bound. */
  private readonly runs = new Map<XmlElement, RunFormat>();
  private readonly labels: { final?: Map<BlockId, NumberingLabel>; original?: Map<BlockId, NumberingLabel> } = {};
  /** Without pending revisions every view is the current state. */
  readonly pending: boolean;

  constructor(
    private readonly index: DocxIndex,
    private readonly base: RunFilter,
  ) {
    this.pending = index.revisions.groups.length > 0;
  }

  /** A paragraph resolved through the properties the view keeps. */
  paragraph(record: BlockRecord, view: "final" | "original"): ResolvedParagraph {
    const known = this.paragraphs[view].get(record.element);
    if (known !== undefined) return known;
    const table = record.parentTableId === null ? null : this.index.block(record.parentTableId);
    const current = firstChild(record.element, "w:pPr");
    const change = view === "original" ? this.index.scan(record.element).propertiesChange : null;
    const pPr = change === null ? current : oldProperties(change);
    const resolved = this.index.resolver.paragraphFromProps(pPr, tableStyleIdOf(table?.element ?? null));
    this.paragraphs[view].set(record.element, resolved);
    return resolved;
  }

  /** The format of a run in the `original` view: its old properties on the old paragraph base. */
  originalRunFormat(run: XmlElement | null, paragraph: ResolvedParagraph): RunFormat {
    // An object outside a run takes the paragraph base, which differs between paragraphs.
    if (run === null) return this.index.resolver.runFormat(paragraph.runBase, null);
    let known = this.runs.get(run);
    if (known === undefined) {
      const rPr = firstChild(run, "w:rPr");
      const change = rPr === null ? null : firstChild(rPr, "w:rPrChange");
      known = this.index.resolver.runFormat(paragraph.runBase, change === null ? rPr : oldProperties(change));
      this.runs.set(run, known);
    }
    return known;
  }

  /** Numbering labels counted over the paragraphs the view keeps, by the block whose properties a shown paragraph uses. */
  labelsIn(view: "final" | "original"): Map<BlockId, NumberingLabel> {
    const known = this.labels[view];
    if (known !== undefined) return known;
    const numbered: NumberedParagraph[] = [];
    const ids = new Map<XmlElement, BlockId>();
    const visit = (blocks: readonly FlatBlock[]): void => {
      for (const block of blocks) {
        if (block.type === "paragraph") {
          const record = this.index.block(block.block.id);
          const numbering = record === null || record.type !== "paragraph" ? null : this.paragraph(record, view).numbering;
          if (record === null || numbering === null) continue;
          numbered.push({ element: record.element, numId: numbering.numId, level: numbering.level });
          ids.set(record.element, record.id);
        } else if (block.type === "table") {
          for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks);
        }
      }
    };
    // Every story in the order `index.labels` counts them, so lists continue across stories the same way.
    for (const story of this.index.structure.stories) visit(flattenBlocks(buildStory(this.index, story).blocks, view, this.base));
    const labels = new Map<BlockId, NumberingLabel>();
    for (const [element, label] of computeNumberingLabels(numbered, this.index.resolver.numbering)) {
      const id = ids.get(element);
      if (id !== undefined) labels.set(id, label);
    }
    this.labels[view] = labels;
    return labels;
  }
}

function filterWithIndex(index: DocxIndex): RunFilter {
  let properties: ViewProperties | null = null;
  const filter: RunFilter = (block, view) => {
    const record = index.block(block.id);
    if (record === null || record.type !== "paragraph") return markRunFilter(block, view);
    const scan = index.scan(record.element);
    // The original view shows the formatting that rejecting would restore.
    properties ??= new ViewProperties(index, base);
    const reformat = view === "original" && properties.pending ? properties : null;
    const paragraph = reformat === null ? null : reformat.paragraph(record, "original");
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
          const format = reformat === null || paragraph === null ? null : reformat.originalRunFormat(atom?.run ?? null, paragraph);
          if (piece === null || (format !== null && !sameFormat(formatOf(piece), format))) {
            piece = format === null ? { ...run, start: position, text } : { ...run, ...format, start: position, text };
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
  // The flattening that counts labels must not ask for labels itself.
  const base: RunFilter = Object.assign((block: ParagraphBlock, view: DocxTextView) => filter(block, view), {
    markGone: filter.markGone,
    rowGone: filter.rowGone,
    cellsGone: filter.cellsGone,
  });
  filter.paragraphIn = (block, view) => {
    properties ??= new ViewProperties(index, base);
    const record = index.block(block.id);
    if (view === "markup" || !properties.pending || record === null || record.type !== "paragraph") return block;
    const style = view === "original" ? properties.paragraph(record, view).style : block.style;
    const label = properties.labelsIn(view).get(block.id);
    return { ...block, style, numbering: label === undefined ? null : { ...label, counters: [...label.counters] } };
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
