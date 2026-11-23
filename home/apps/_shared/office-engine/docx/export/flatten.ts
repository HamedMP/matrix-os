/**
 * The blocks of a story as a reader of one view sees them, shared by the
 * HTML, Markdown and plain-text exports.
 *
 * In `markup` every run, row and paragraph is kept. In `final` and
 * `original` the runs and table rows that are gone in that view are left
 * out, and a paragraph whose mark is gone (a deleted mark in `final`, an
 * inserted one in `original`) runs on into the next paragraph, the rule
 * `getPlainText` applies. The merged paragraph keeps the properties of the
 * first paragraph that contributes visible content.
 */

import type {
  BlockId,
  DocxBlock,
  DocxTextView,
  InlineRun,
  ParagraphBlock,
  RevisionKind,
  SectionBreakBlock,
  TableBlock,
  TableCell,
  TableRow,
} from "../../api/docx-model.js";

export interface FlatParagraph {
  type: "paragraph";
  /** The paragraph whose properties (style, numbering, revisions of the mark) the output uses. */
  block: ParagraphBlock;
  /** Every source paragraph merged into this one, in order. */
  blockIds: BlockId[];
  runs: InlineRun[];
  bookmarks: string[];
}

export interface FlatCell {
  cell: TableCell;
  /** Rows spanned among the rows kept in the view. */
  rowSpan: number;
  blocks: FlatBlock[];
}

export interface FlatRow {
  row: TableRow;
  /** Cells that start here; continuations of a vertical merge are left out. */
  cells: FlatCell[];
}

export interface FlatTable {
  type: "table";
  block: TableBlock;
  rows: FlatRow[];
}

export interface FlatSectionBreak {
  type: "sectionBreak";
  block: SectionBreakBlock;
}

export type FlatBlock = FlatParagraph | FlatTable | FlatSectionBreak;

/** The runs of a paragraph that a view shows. */
export type RunFilter = (block: ParagraphBlock, view: DocxTextView) => InlineRun[];

/** The filter that uses the revision mark of each run only. */
export const markRunFilter: RunFilter = (block, view) => block.runs.filter((run) => !goneInView(run.revision?.kind, view));

/** Nesting bound for tables in table cells; deeper content is left out. */
const MAX_TABLE_DEPTH = 32;

/** True when content carrying a revision of this kind is not shown in the view. */
export function goneInView(kind: RevisionKind | undefined, view: DocxTextView): boolean {
  if (kind === undefined || kind === "format" || view === "markup") return false;
  const removal = kind === "delete" || kind === "moveFrom";
  return view === "final" ? removal : !removal;
}

function flattenTable(table: TableBlock, view: DocxTextView, filter: RunFilter, depth: number): FlatTable {
  const kept = table.rows.filter((row) => !goneInView(row.revision?.kind, view));
  const rows: FlatRow[] = kept.map((row, rowIndex) => {
    const cells: FlatCell[] = [];
    row.cells.forEach((cell, cellIndex) => {
      if (cell.mergedAbove) return;
      let rowSpan = 1;
      if (cell.rowSpan > 1) {
        // Count the continuation cells that are still there: the same grid column in the following kept rows.
        const column = gridColumn(row, cellIndex);
        for (let next = rowIndex + 1; next < kept.length; next++) {
          const continuation = cellAtColumn(kept[next] as TableRow, column);
          if (continuation === null || !continuation.mergedAbove) break;
          rowSpan++;
        }
      }
      cells.push({ cell, rowSpan, blocks: depth >= MAX_TABLE_DEPTH ? [] : flattenWith(cell.blocks, view, filter, depth + 1) });
    });
    return { row, cells };
  });
  return { type: "table", block: table, rows };
}

function gridColumn(row: TableRow, cellIndex: number): number {
  let column = 0;
  for (let index = 0; index < cellIndex; index++) column += Math.max(1, (row.cells[index] as TableCell).colSpan);
  return column;
}

function cellAtColumn(row: TableRow, column: number): TableCell | null {
  let start = 0;
  for (const cell of row.cells) {
    if (start === column) return cell;
    start += Math.max(1, cell.colSpan);
    if (start > column) return null;
  }
  return null;
}

function flattenWith(blocks: readonly DocxBlock[], view: DocxTextView, filter: RunFilter, depth: number): FlatBlock[] {
  const out: FlatBlock[] = [];
  let carry: FlatParagraph | null = null;
  blocks.forEach((block, position) => {
    if (block.type === "table") {
      out.push(flattenTable(block, view, filter, depth));
      return;
    }
    if (block.type === "sectionBreak") {
      out.push({ type: "sectionBreak", block });
      return;
    }
    const runs = view === "markup" ? block.runs : filter(block, view);
    let paragraph: FlatParagraph;
    if (carry === null) {
      paragraph = { type: "paragraph", block, blockIds: [block.id], runs, bookmarks: [...block.bookmarks] };
    } else {
      const visible = carry.runs.length > 0;
      paragraph = {
        type: "paragraph",
        block: visible ? carry.block : block,
        blockIds: [...carry.blockIds, block.id],
        runs: [...carry.runs, ...runs],
        bookmarks: [...carry.bookmarks, ...block.bookmarks],
      };
    }
    carry = null;
    const next = blocks[position + 1];
    if (goneInView(block.markRevision?.kind, view) && next !== undefined && next.type === "paragraph") {
      carry = paragraph;
      return;
    }
    out.push(paragraph);
  });
  return out;
}

/**
 * The blocks of a story in a view; see the module comment. `filter` picks
 * the runs a view shows; the default reads each run's revision mark, which
 * misses content nested in two revisions (see `./visibility.ts`).
 */
export function flattenBlocks(
  blocks: readonly DocxBlock[],
  view: DocxTextView,
  filter: RunFilter = markRunFilter,
): FlatBlock[] {
  return flattenWith(blocks, view, filter, 0);
}
