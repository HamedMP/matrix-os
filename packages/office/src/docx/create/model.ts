/**
 * The content of a new document before it becomes XML: paragraphs of runs
 * and simple tables. `createDocx` builds it from `NewParagraph`s and the
 * Markdown importer from Markdown; `./body-xml.ts` writes it.
 */

import type { NewParagraph } from "../../api/docx.js";
import type { ParagraphAlignment, ParagraphStylePatch } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";

/** One stretch of text with the same formatting. `\t` is a tab and `\n` a line break. */
export interface NewRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** Inline code: the `InlineCode` character style. */
  code?: boolean;
  /** External link target; only `http:`, `https:` and `mailto:` are written as links. */
  href?: string;
}

/** A list membership: the numbering instance and the level (0 to 8). */
export interface NewListItem {
  numId: number;
  level: number;
}

export interface NewParagraphBlock {
  type: "paragraph";
  runs: NewRun[];
  /** A style id from {@link BUILT_IN_PARAGRAPH_STYLES}; absent for Normal. */
  styleId?: string;
  alignment?: ParagraphAlignment;
  indentLeftPt?: number;
  indentRightPt?: number;
  firstLineIndentPt?: number;
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  list?: NewListItem;
}

export interface NewTableBlock {
  type: "table";
  /** Rows of cells; each cell is a list of runs. Short rows are padded with empty cells. */
  rows: NewRun[][][];
  /** The first row repeats as a header and is bold. */
  header: boolean;
  /** Alignment per column, or null for the default. */
  alignments: Array<ParagraphAlignment | null>;
}

export type NewBlock = NewParagraphBlock | NewTableBlock;

/** Paragraph style ids the created styles part defines, keyed by id. */
export const BUILT_IN_PARAGRAPH_STYLES: ReadonlySet<string> = new Set([
  "Normal",
  "Heading1",
  "Heading2",
  "Heading3",
  "Heading4",
  "Heading5",
  "Heading6",
  "Heading7",
  "Heading8",
  "Heading9",
  "Title",
  "Subtitle",
  "Quote",
  "ListParagraph",
  "CodeBlock",
]);

/** Upper bound on the blocks of one new document. */
export const MAX_NEW_BLOCKS = 50_000;
/** Upper bound on the text of one new document, in UTF-16 code units. */
export const MAX_NEW_TEXT = 4_000_000;
/** Largest indent or spacing accepted, in points (22 inches). */
const MAX_LENGTH_PT = 1584;
/** The largest table a new document can hold. */
export const MAX_TABLE_COLUMNS = 63;
export const MAX_TABLE_ROWS = 5_000;

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NON_CHARACTER = /[￾￿]/g;

/**
 * Checks caller text: `\t` and `\n` are allowed, other C0 controls throw
 * `invalid_argument`. Unpaired surrogates and U+FFFE/U+FFFF, which XML cannot
 * carry, become U+FFFD.
 */
export function checkInsertableText(text: unknown): string {
  if (typeof text !== "string") throw new OfficeError("invalid_argument", "paragraph text must be a string");
  if (CONTROL.test(text)) throw new OfficeError("invalid_argument", "paragraph text contains a control character");
  return text.replace(LONE_SURROGATE, "�").replace(NON_CHARACTER, "�");
}

/** Removes what XML cannot carry from free text (Markdown, titles): controls other than tab and newline. */
export function cleanFreeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(LONE_SURROGATE, "�")
    .replace(NON_CHARACTER, "�");
}

function checkLength(value: unknown, name: string, allowNegative: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OfficeError("invalid_argument", `${name} must be a finite number`);
  }
  if (value > MAX_LENGTH_PT || value < (allowNegative ? -MAX_LENGTH_PT : 0)) {
    throw new OfficeError("invalid_argument", `${name} is out of range`);
  }
  return value;
}

const ALIGNMENTS: ReadonlySet<string> = new Set(["left", "center", "right", "justify"]);

/** Turns a `ParagraphStylePatch` into paragraph properties; unknown style ids throw `invalid_operation`. */
export function applyStylePatch(block: NewParagraphBlock, patch: Partial<ParagraphStylePatch>): void {
  if (patch.headingLevel !== undefined) {
    const level = patch.headingLevel;
    if (!Number.isInteger(level) || level < 0 || level > 9) {
      throw new OfficeError("invalid_argument", "headingLevel must be an integer from 0 to 9");
    }
    if (level === 0) delete block.styleId;
    else block.styleId = `Heading${level}`;
  } else if (patch.styleId !== undefined) {
    if (patch.styleId === null || patch.styleId === "Normal") {
      delete block.styleId;
    } else if (!BUILT_IN_PARAGRAPH_STYLES.has(patch.styleId)) {
      throw new OfficeError("invalid_operation", "unknown paragraph style", { details: { styleId: patch.styleId } });
    } else {
      block.styleId = patch.styleId;
    }
  }
  if (patch.alignment !== undefined) {
    if (!ALIGNMENTS.has(patch.alignment)) throw new OfficeError("invalid_argument", "unknown alignment");
    block.alignment = patch.alignment;
  }
  if (patch.indentLeftPt !== undefined) block.indentLeftPt = checkLength(patch.indentLeftPt, "indentLeftPt", true);
  if (patch.indentRightPt !== undefined) block.indentRightPt = checkLength(patch.indentRightPt, "indentRightPt", true);
  if (patch.firstLineIndentPt !== undefined) {
    block.firstLineIndentPt = checkLength(patch.firstLineIndentPt, "firstLineIndentPt", true);
  }
  if (patch.spacingBeforePt !== undefined) {
    block.spacingBeforePt = checkLength(patch.spacingBeforePt, "spacingBeforePt", false);
  }
  if (patch.spacingAfterPt !== undefined) block.spacingAfterPt = checkLength(patch.spacingAfterPt, "spacingAfterPt", false);
}

/** The blocks for `CreateDocxOptions.paragraphs`. */
export function blocksFromParagraphs(paragraphs: readonly NewParagraph[] | undefined): NewBlock[] {
  if (paragraphs === undefined) return [];
  if (!Array.isArray(paragraphs)) throw new OfficeError("invalid_argument", "paragraphs must be an array");
  if (paragraphs.length > MAX_NEW_BLOCKS) throw new OfficeError("limit_exceeded", "too many paragraphs");
  let total = 0;
  return paragraphs.map((paragraph) => {
    const isObject = typeof paragraph === "object" && paragraph !== null;
    const text = checkInsertableText(isObject ? paragraph.text : paragraph);
    total += text.length;
    if (total > MAX_NEW_TEXT) throw new OfficeError("limit_exceeded", "the document text is too long");
    const block: NewParagraphBlock = { type: "paragraph", runs: text === "" ? [] : [{ text }] };
    if (isObject && paragraph.style !== undefined) {
      if (typeof paragraph.style !== "object" || paragraph.style === null) {
        throw new OfficeError("invalid_argument", "paragraph style must be an object");
      }
      applyStylePatch(block, paragraph.style);
    }
    return block;
  });
}
