/**
 * The text of the body's paragraphs as one view shows it, with a map back to
 * markup offsets (the coordinates of `TextPosition`). Find, defined-term
 * lookup and word counts read the document through this.
 */

import type { BlockId, DocxBlock, DocxDocument, DocxTextView, RevisionKind, TextRange } from "../../../_shared/office-engine/index";

export interface ParagraphText {
  blockId: BlockId;
  /** The visible text. */
  text: string;
  /** Markup offset of each visible character. */
  offsets: number[];
}

/** Whether a run with this revision is hidden in a view. */
export function hiddenInView(kind: RevisionKind | undefined, view: DocxTextView): boolean {
  if (kind === undefined || kind === "format" || view === "markup") return false;
  const removal = kind === "delete" || kind === "moveFrom";
  return view === "final" ? removal : !removal;
}

function collect(blocks: readonly DocxBlock[], view: DocxTextView, out: ParagraphText[]): void {
  for (const block of blocks) {
    if (block.type === "table") {
      for (const row of block.rows) {
        if (hiddenInView(row.revision?.kind, view)) continue;
        for (const cell of row.cells) if (!cell.mergedAbove) collect(cell.blocks, view, out);
      }
      continue;
    }
    if (block.type !== "paragraph") continue;
    let text = "";
    const offsets: number[] = [];
    for (const run of block.runs) {
      if (hiddenInView(run.revision?.kind, view)) continue;
      text += run.text;
      for (let index = 0; index < run.text.length; index++) offsets.push(run.start + index);
    }
    out.push({ blockId: block.id, text, offsets });
  }
}

/** Every paragraph of the body, including those in table cells, in document order. */
export function visibleParagraphs(doc: DocxDocument, view: DocxTextView): ParagraphText[] {
  const out: ParagraphText[] = [];
  collect(doc.getView().body.blocks, view, out);
  return out;
}

/** The markup range of visible characters `[from, to)` of one paragraph. */
export function rangeOf(paragraph: ParagraphText, from: number, to: number): TextRange {
  const start = paragraph.offsets[from] ?? 0;
  const end = (paragraph.offsets[to - 1] ?? start - 1) + 1;
  return { start: { blockId: paragraph.blockId, offset: start }, end: { blockId: paragraph.blockId, offset: end } };
}
