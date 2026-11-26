/**
 * The text of a paragraph as an agent sees it, with the way back to the
 * markup coordinates that edit operations use.
 *
 * A description shows the `final` view of a paragraph on one line: pending
 * deletions and inline objects are left out and every kind of line break is
 * a space. {@link paragraphFinalText} produces that text together with the
 * markup offset of each character, so text quoted from a description can be
 * found again and turned into a `TextRange`.
 */

import type { DocxBlock, DocxStory, ParagraphBlock, TableBlock } from "../api/docx.js";

const OBJECT = "￼";

/** True for the characters a description writes as a space. */
function isLineBreak(code: number): boolean {
  // \n, \v, \f, \r, NEL, LS, PS.
  return (code >= 0x0a && code <= 0x0d) || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/** Text on one line: every kind of line break becomes a space. */
export function singleLine(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isLineBreak(text.charCodeAt(i))) continue;
    out += `${text.slice(from, i)} `;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

export interface FinalText {
  /** The `final` text on one line, without inline objects. */
  text: string;
  /** Markup offset of each character of `text`. */
  offsets: number[];
  /** Length of the paragraph's markup text. */
  markupLength: number;
}

/** The `final` text of a paragraph and where each of its characters is in the markup text. */
export function paragraphFinalText(block: ParagraphBlock): FinalText {
  let text = "";
  const offsets: number[] = [];
  for (const run of block.runs) {
    const kind = run.revision?.kind;
    if (kind === "delete" || kind === "moveFrom") continue;
    for (let i = 0; i < run.text.length; i++) {
      const ch = run.text[i] as string;
      if (ch === OBJECT) continue;
      text += isLineBreak(ch.charCodeAt(0)) ? " " : ch;
      offsets.push(run.start + i);
    }
  }
  return { text, offsets, markupLength: block.text.length };
}

/** True when the paragraph disappears if every pending revision is accepted. */
export function isRemovedParagraph(block: ParagraphBlock): boolean {
  const mark = block.markRevision?.kind;
  if (mark !== "delete" && mark !== "moveFrom") return false;
  return block.runs.every((run) => run.revision?.kind === "delete" || run.revision?.kind === "moveFrom");
}

/** Where a paragraph sits when it is inside a table: row and cell of the innermost table, from 1. */
export interface TablePlace {
  row: number;
  cell: number;
}

export interface FlatBlock {
  block: DocxBlock;
  /** Position in document order across the stories that were walked. */
  order: number;
  /** Set for a paragraph or table inside a table cell. */
  place: TablePlace | null;
}

/**
 * Which table rows and cells a walk leaves out, by their index in the view
 * model. Without one every row and cell is walked.
 */
export interface TableVisibility {
  rowGone(table: TableBlock, rowIndex: number): boolean;
  cellGone(table: TableBlock, rowIndex: number, cellIndex: number): boolean;
}

/** Deepest table nesting that is walked; deeper content is left out. */
const MAX_TABLE_DEPTH = 32;

/**
 * Every block of the stories in document order: a table comes before the
 * blocks in its cells. Iterative, so a deeply nested table cannot overflow
 * the stack. With `visibility`, rows and cells it leaves out are not walked,
 * a table with no row left is left out with its content, and places are
 * counted among the rows and cells that are kept.
 */
export function flattenStories(stories: readonly DocxStory[], visibility?: TableVisibility): FlatBlock[] {
  const flat: FlatBlock[] = [];
  interface Frame {
    blocks: readonly DocxBlock[];
    index: number;
    place: TablePlace | null;
    depth: number;
  }
  for (const story of stories) {
    const stack: Frame[] = [{ blocks: story.blocks, index: 0, place: null, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.index >= frame.blocks.length) {
        stack.pop();
        continue;
      }
      const block = frame.blocks[frame.index++] as DocxBlock;
      if (block.type === "table" && visibility !== undefined && tableGone(block, visibility)) continue;
      flat.push({ block, order: flat.length, place: frame.place });
      if (block.type !== "table" || frame.depth >= MAX_TABLE_DEPTH) continue;
      // Pushed in reverse so the first cell is walked first.
      const cells = tableCells(block, visibility);
      for (let i = cells.length - 1; i >= 0; i--) {
        const cell = cells[i] as { blocks: DocxBlock[]; place: TablePlace };
        stack.push({ blocks: cell.blocks, index: 0, place: cell.place, depth: frame.depth + 1 });
      }
    }
  }
  return flat;
}

function tableCells(table: TableBlock, visibility: TableVisibility | undefined): Array<{ blocks: DocxBlock[]; place: TablePlace }> {
  const cells: Array<{ blocks: DocxBlock[]; place: TablePlace }> = [];
  let rowNumber = 0;
  table.rows.forEach((row, rowIndex) => {
    if (visibility?.rowGone(table, rowIndex)) return;
    rowNumber++;
    let cellNumber = 0;
    row.cells.forEach((cell, cellIndex) => {
      if (visibility?.cellGone(table, rowIndex, cellIndex)) return;
      cells.push({ blocks: cell.blocks, place: { row: rowNumber, cell: ++cellNumber } });
    });
  });
  return cells;
}

/** True when a table has rows and the walk leaves out every one of them. */
function tableGone(table: TableBlock, visibility: TableVisibility): boolean {
  return table.rows.length > 0 && table.rows.every((_, rowIndex) => visibility.rowGone(table, rowIndex));
}

/** Start offsets of every non-overlapping occurrence of `needle` in `text`. `needle` is not empty. */
export function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return found;
    found.push(at);
    from = at + needle.length;
  }
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_]/u;

function isWordChar(text: string, index: number): boolean {
  return index >= 0 && index < text.length && WORD_CHAR.test(text[index] as string);
}

/**
 * How much of `before` and `after` is the same at both ends, in whole
 * words: the differing middle never starts or ends inside a word, and a
 * surrogate pair is never split.
 */
export function commonEnds(before: string, after: string): { prefix: number; suffix: number } {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && (splitsWord(before, prefix) || splitsWord(after, prefix))) prefix--;
  let suffix = 0;
  const room = limit - prefix;
  while (suffix < room && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  while (suffix > 0 && (splitsWord(before, before.length - suffix) || splitsWord(after, after.length - suffix))) suffix--;
  return { prefix, suffix };
}

/** True when the boundary before `index` falls inside a word or a surrogate pair. */
function splitsWord(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return true;
  return isWordChar(text, index - 1) && isWordChar(text, index);
}
