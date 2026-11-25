/**
 * The blocks of a story as a reader of one view sees them, shared by the
 * HTML, Markdown and plain-text exports.
 *
 * In `markup` every run, row and paragraph is kept. In `final` and
 * `original` the runs, table rows and table cells that are gone in that
 * view are left out, and a paragraph whose mark is gone (a deleted mark in `final`, an
 * inserted one in `original`) runs on into the next paragraph, the rule
 * `getPlainText` applies. The merged paragraph keeps the properties of the
 * first paragraph that contributes visible content. Such a paragraph with
 * nothing to show and no paragraph after it is left out before a table and
 * at the end of its container, as resolving the revision removes it. A
 * table with no row left in the view is left out with its rows.
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
  /**
   * Every cell of the row that the view keeps, in order: with its entry in
   * `cells`, or null for a continuation of a vertical merge, which still
   * takes its place in the row.
   */
  slots: Array<{ cell: TableCell; flat: FlatCell | null }>;
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

/**
 * The runs of a paragraph that a view shows. A filter that reads the
 * document itself can also say whether a paragraph mark, a table row or a
 * table cell is gone in a view; without that the one revision the view
 * model shows on the mark or row decides, which misses a mark or row that
 * carries two and every tracked cell (the view model has no mark for one).
 */
export interface RunFilter {
  (block: ParagraphBlock, view: DocxTextView): InlineRun[];
  markGone?(block: ParagraphBlock, view: DocxTextView): boolean;
  rowGone?(table: TableBlock, rowIndex: number, view: DocxTextView): boolean;
  /** The cells of a row that are gone in the view, by position (`true` where gone), or null when all stay. */
  cellsGone?(table: TableBlock, rowIndex: number, view: DocxTextView): readonly (boolean | undefined)[] | null;
  /**
   * The paragraph as the view shows it: the style its properties in that
   * view give it, and the numbering label counted among the paragraphs the
   * view keeps. Without it the paragraph is shown with its current style and
   * the label counted over every paragraph.
   */
  paragraphIn?(block: ParagraphBlock, view: DocxTextView): ParagraphBlock;
}

/** The filter that uses the revision mark of each run only. */
export const markRunFilter: RunFilter = (block, view) => block.runs.filter((run) => !goneInView(run.revision?.kind, view));

/**
 * Whether a paragraph without a mark and without content goes when its
 * revision is resolved: before a table, and at the end of its container
 * after another paragraph. It stays when it carries a section break (the
 * next block) or is all its container has. The same rule as `getPlainText`.
 */
function emptyParagraphGoes(next: DocxBlock | undefined, previous: DocxBlock | undefined): boolean {
  if (next === undefined) return previous !== undefined && previous.type === "paragraph";
  return next.type === "table";
}

/** Nesting bound for tables in table cells; deeper content is left out. */
const MAX_TABLE_DEPTH = 32;

/** True when content carrying a revision of this kind is not shown in the view. */
export function goneInView(kind: RevisionKind | undefined, view: DocxTextView): boolean {
  if (kind === undefined || kind === "format" || view === "markup") return false;
  const removal = kind === "delete" || kind === "moveFrom";
  return view === "final" ? removal : !removal;
}

function flattenTable(table: TableBlock, view: DocxTextView, filter: RunFilter, depth: number): FlatTable {
  // The rows the view keeps, each with the cells it keeps: columns and spans are counted among those.
  const kept: Array<{ row: TableRow; cells: readonly TableCell[] }> = [];
  table.rows.forEach((row, rowIndex) => {
    if (filter.rowGone?.(table, rowIndex, view) ?? goneInView(row.revision?.kind, view)) return;
    const gone = view === "markup" ? null : (filter.cellsGone?.(table, rowIndex, view) ?? null);
    kept.push({ row, cells: gone === null ? row.cells : row.cells.filter((_cell, cellIndex) => gone[cellIndex] !== true) });
  });
  const rows: FlatRow[] = kept.map(({ row, cells: source }, rowIndex) => {
    const cells: FlatCell[] = [];
    const slots: FlatRow["slots"] = [];
    let column = 0;
    for (const cell of source) {
      const start = column;
      column += Math.max(1, cell.colSpan);
      if (cell.mergedAbove) {
        slots.push({ cell, flat: null });
        continue;
      }
      let rowSpan = 1;
      if (cell.rowSpan > 1) {
        // Count the continuation cells that are still there: the same grid column in the following kept rows.
        for (let next = rowIndex + 1; next < kept.length; next++) {
          const continuation = cellAtColumn((kept[next] as { cells: readonly TableCell[] }).cells, start);
          if (continuation === null || !continuation.mergedAbove) break;
          rowSpan++;
        }
      }
      const flat: FlatCell = { cell, rowSpan, blocks: depth >= MAX_TABLE_DEPTH ? [] : flattenWith(cell.blocks, view, filter, depth + 1) };
      cells.push(flat);
      slots.push({ cell, flat });
    }
    return { row, cells, slots };
  });
  return { type: "table", block: table, rows };
}

function cellAtColumn(cells: readonly TableCell[], column: number): TableCell | null {
  let start = 0;
  for (const cell of cells) {
    if (start === column) return cell;
    start += Math.max(1, cell.colSpan);
    if (start > column) return null;
  }
  return null;
}

function flattenWith(source: readonly DocxBlock[], view: DocxTextView, filter: RunFilter, depth: number): FlatBlock[] {
  const out: FlatBlock[] = [];
  let carry: FlatParagraph | null = null;
  // A table with no row left in the view is gone, for the paragraphs around it too.
  const tables = new Map<DocxBlock, FlatTable>();
  const blocks = source.filter((block) => {
    if (block.type !== "table") return true;
    const flat = flattenTable(block, view, filter, depth);
    tables.set(block, flat);
    return view === "markup" || flat.rows.length > 0 || block.rows.length === 0;
  });
  blocks.forEach((block, position) => {
    if (block.type === "table") {
      out.push(tables.get(block) as FlatTable);
      return;
    }
    if (block.type === "sectionBreak") {
      out.push({ type: "sectionBreak", block });
      return;
    }
    const runs = view === "markup" ? block.runs : filter(block, view);
    const shown = view === "markup" ? block : (filter.paragraphIn?.(block, view) ?? block);
    let paragraph: FlatParagraph;
    if (carry === null) {
      paragraph = { type: "paragraph", block: shown, blockIds: [block.id], runs, bookmarks: [...block.bookmarks] };
    } else {
      const visible = carry.runs.length > 0;
      paragraph = {
        type: "paragraph",
        block: visible ? carry.block : shown,
        blockIds: [...carry.blockIds, block.id],
        runs: [...carry.runs, ...runs],
        bookmarks: [...carry.bookmarks, ...block.bookmarks],
      };
    }
    carry = null;
    const next = blocks[position + 1];
    const gone = filter.markGone?.(block, view) ?? goneInView(block.markRevision?.kind, view);
    if (gone && next !== undefined && next.type === "paragraph") {
      carry = paragraph;
      return;
    }
    // Without a mark and without content there is no paragraph left once the revision is resolved.
    if (gone && paragraph.runs.length === 0 && emptyParagraphGoes(next, blocks[position - 1])) return;
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
