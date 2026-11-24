/**
 * What the ribbon shows about the place of the caret beyond the editor's
 * `ActiveFormat`: the run's font, size and colours, the paragraph's indent and
 * spacing, the table row around it, and the paragraph styles the document
 * itself uses. Pure reads of the engine document.
 */

import type { DocxBlock, DocxDocument, InlineRun, ParagraphBlock, RunFormat, TextPosition } from "../../../../_shared/office-engine/index";

export interface TableRowRef {
  tableId: string;
  rowIndex: number;
  rowCount: number;
}

export interface CaretFormat {
  fontFamily: string | null;
  fontSizePt: number | null;
  color: string | null;
  highlight: string | null;
  verticalAlign: RunFormat["verticalAlign"];
  indentLeftPt: number;
  spacingBeforePt: number;
  spacingAfterPt: number;
  /** The innermost table row around the caret, or null outside a table. */
  row: TableRowRef | null;
}

/** Most paragraphs scanned for document styles, so a long document stays cheap. */
const STYLE_SCAN_LIMIT = 2_000;
/** Most document styles offered besides the built-in ones. */
const MAX_DOCUMENT_STYLES = 12;

function paragraphOf(doc: DocxDocument, blockId: string): ParagraphBlock | null {
  const block = doc.getBlock(blockId);
  return block !== null && block.type === "paragraph" ? block : null;
}

/** The run that formats text typed at `offset`: the one before the caret, or the first one at the start. */
export function runAt(paragraph: ParagraphBlock, offset: number): InlineRun | null {
  let first: InlineRun | null = null;
  for (const run of paragraph.runs) {
    first ??= run;
    if (offset > run.start && offset <= run.start + run.text.length) return run;
  }
  return first;
}

/** The innermost table row whose cells hold the block, or null. */
export function tableRowOf(blocks: readonly DocxBlock[], blockId: string): TableRowRef | null {
  for (const block of blocks) {
    if (block.type !== "table") continue;
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
      for (const cell of block.rows[rowIndex]!.cells) {
        const inner = tableRowOf(cell.blocks, blockId);
        if (inner !== null) return inner;
        if (cell.blocks.some((child) => child.id === blockId)) return { tableId: block.id, rowIndex, rowCount: block.rows.length };
      }
    }
  }
  return null;
}

export function caretFormat(doc: DocxDocument | null, focus: TextPosition | null, inTable: boolean): CaretFormat | null {
  if (doc === null || focus === null) return null;
  const paragraph = paragraphOf(doc, focus.blockId);
  if (paragraph === null) return null;
  const run = runAt(paragraph, focus.offset);
  return {
    fontFamily: run?.fontFamily ?? null,
    fontSizePt: run?.fontSizePt ?? null,
    color: run?.color ?? null,
    highlight: run?.highlight ?? null,
    verticalAlign: run?.verticalAlign ?? "baseline",
    indentLeftPt: paragraph.style.indentLeftPt,
    spacingBeforePt: paragraph.style.spacingBeforePt,
    spacingAfterPt: paragraph.style.spacingAfterPt,
    // Only walked when the editor says the caret is in a table.
    row: inTable ? tableRowOf(doc.getView().body.blocks, focus.blockId) : null,
  };
}

export interface DocumentStyle {
  styleId: string;
  name: string;
}

/** Paragraph styles the document's body uses, in first-use order, headings excluded. */
export function documentStyles(doc: DocxDocument | null): DocumentStyle[] {
  if (doc === null) return [];
  const found = new Map<string, string>();
  let scanned = 0;
  const visit = (blocks: readonly DocxBlock[]): void => {
    for (const block of blocks) {
      if (scanned >= STYLE_SCAN_LIMIT || found.size >= MAX_DOCUMENT_STYLES) return;
      if (block.type === "table") {
        for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks);
        continue;
      }
      if (block.type !== "paragraph") continue;
      scanned++;
      const { styleId, styleName, headingLevel } = block.style;
      if (styleId !== null && headingLevel === 0 && !found.has(styleId)) found.set(styleId, styleName ?? styleId);
    }
  };
  visit(doc.getView().body.blocks);
  return [...found].map(([styleId, name]) => ({ styleId, name }));
}
