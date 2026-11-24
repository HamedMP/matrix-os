/**
 * Block-level Markdown for `createDocxFromMarkdown`: headings, paragraphs,
 * ordered and bulleted lists (nested by indentation), block quotes, fenced
 * code, thematic breaks (dropped) and pipe tables. Inline content goes
 * through `./markdown-inline.ts`.
 */

import type { ParagraphAlignment } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import { parseInline } from "./markdown-inline.js";
import {
  MAX_NEW_BLOCKS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type NewBlock,
  type NewParagraphBlock,
  type NewRun,
  cleanFreeText,
} from "./model.js";
import { BULLET_NUM_ID } from "./parts-xml.js";

/** Largest Markdown input accepted, in UTF-16 code units. */
export const MAX_MARKDOWN_LENGTH = 2_000_000;
const MAX_LEVEL = 8;
const MAX_START = 32_767;

export interface MarkdownImport {
  blocks: NewBlock[];
  /** One numbering instance per ordered list, each restarting at `start`. */
  decimalLists: Array<{ numId: number; start: number }>;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-+*]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER_CELL = /^:?-+:?$/;

interface ListLevel {
  markerIndent: number;
  contentColumn: number;
}

interface PendingParagraph {
  lines: string[];
  styleId?: string;
  list?: { numId: number; level: number };
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const char of line) out += char === "\t" ? " ".repeat(4 - (out.length % 4)) : char;
  return out;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === "";

/** Joins the lines of a paragraph: two trailing spaces or a backslash make a line break. */
function joinLines(lines: readonly string[]): string {
  let text = "";
  lines.forEach((raw, index) => {
    const line = raw.trimStart();
    if (index === lines.length - 1) {
      text += line.trimEnd();
      return;
    }
    if (/ {2,}$/.test(line)) text += `${line.trimEnd()}\n`;
    else if (/(?<!\\)\\$/.test(line)) text += `${line.slice(0, -1)}\n`;
    else text += `${line.trimEnd()} `;
  });
  return text;
}

/** Splits a table row on unescaped pipes; `\|` becomes a literal pipe. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      current += "\\|";
      index++;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function delimiterAlignments(line: string): Array<ParagraphAlignment | null> | null {
  if (!line.includes("-")) return null;
  const cells = splitRow(line);
  if (cells.length === 0 || !cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

const cellRuns = (cell: string): NewRun[] => parseInline(cell.replace(/\\\|/g, "|"));

class MarkdownParser {
  readonly blocks: NewBlock[] = [];
  readonly decimalLists: Array<{ numId: number; start: number }> = [];
  private pending: PendingParagraph | null = null;
  private list: { stack: ListLevel[]; numId: number | null; blankSeen: boolean } | null = null;
  private nextNumId: number;

  constructor(firstNumId: number) {
    this.nextNumId = firstNumId;
  }

  private push(block: NewBlock): void {
    if (this.blocks.length >= MAX_NEW_BLOCKS) throw new OfficeError("limit_exceeded", "the Markdown has too many blocks");
    this.blocks.push(block);
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    const block: NewParagraphBlock = { type: "paragraph", runs: parseInline(joinLines(pending.lines)) };
    if (pending.styleId !== undefined) block.styleId = pending.styleId;
    if (pending.list !== undefined) block.list = pending.list;
    this.push(block);
  }

  private closeList(): void {
    this.flush();
    this.list = null;
  }

  private heading(level: number, text: string): void {
    this.closeList();
    const block: NewParagraphBlock = { type: "paragraph", runs: parseInline(text.trim()), styleId: `Heading${level}` };
    this.push(block);
  }

  run(lines: readonly string[]): void {
    let index = 0;
    while (index < lines.length) index = this.line(lines, index);
    this.closeList();
  }

  /** Handles the line at `index` and returns the index of the next unhandled line. */
  private line(lines: readonly string[], index: number): number {
    const line = lines[index] as string;
    if (isBlank(line)) {
      this.flush();
      if (this.list !== null) this.list.blankSeen = true;
      return index + 1;
    }
    const fence = FENCE.exec(line);
    if (fence !== null && !(fence[1]?.startsWith("`") === true && fence[2]?.includes("`") === true)) {
      return this.fencedCode(lines, index, fence[1] as string);
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      this.heading((atx[1] as string).length, (atx[2] as string).replace(/(?:^|[ \t]+)#+[ \t]*$/, ""));
      return index + 1;
    }
    const setext = SETEXT.exec(line);
    if (setext !== null && this.pending !== null && this.pending.list === undefined && this.pending.styleId === undefined) {
      const text = joinLines(this.pending.lines);
      this.pending = null;
      this.heading((setext[1] as string).startsWith("=") ? 1 : 2, text);
      return index + 1;
    }
    if (THEMATIC.test(line)) {
      this.closeList();
      return index + 1;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) return this.blockQuote(lines, index);
    if (this.pending === null && line.includes("|") && index + 1 < lines.length) {
      const alignments = delimiterAlignments(lines[index + 1] as string);
      if (alignments !== null && splitRow(line).length === alignments.length) return this.table(lines, index, alignments);
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null && (item[5] !== undefined || this.list !== null || this.pending === null)) {
      this.listItem(item);
      return index + 1;
    }
    const list = this.list;
    if (list !== null) {
      const current = list.stack[list.stack.length - 1] as ListLevel;
      const indented = indentOf(line) >= current.contentColumn;
      if (!list.blankSeen && this.pending !== null) {
        this.pending.lines.push(line);
        return index + 1;
      }
      if (indented) {
        // A further paragraph of the current item.
        this.flush();
        this.pending = { lines: [line], styleId: "ListParagraph" };
        list.blankSeen = false;
        return index + 1;
      }
      this.closeList();
    }
    if (this.pending === null) this.pending = { lines: [] };
    this.pending.lines.push(line);
    return index + 1;
  }

  private fencedCode(lines: readonly string[], start: number, fence: string): number {
    this.closeList();
    const code: string[] = [];
    let index = start + 1;
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    while (index < lines.length && !closing.test(lines[index] as string)) code.push(lines[index++] as string);
    this.push({ type: "paragraph", runs: code.length === 0 ? [] : [{ text: code.join("\n") }], styleId: "CodeBlock" });
    return Math.min(lines.length, index + 1);
  }

  private blockQuote(lines: readonly string[], start: number): number {
    this.closeList();
    let index = start;
    let paragraph: string[] = [];
    const emit = (): void => {
      if (paragraph.length > 0) this.push({ type: "paragraph", runs: parseInline(joinLines(paragraph)), styleId: "Quote" });
      paragraph = [];
    };
    while (index < lines.length) {
      const match = QUOTE.exec(lines[index] as string);
      if (match === null) break;
      const content = match[1] as string;
      if (isBlank(content)) emit();
      else paragraph.push(content.replace(/^(?: {0,3}> ?)+/, ""));
      index++;
    }
    emit();
    return index;
  }

  private table(lines: readonly string[], start: number, alignments: Array<ParagraphAlignment | null>): number {
    this.closeList();
    const columns = Math.min(alignments.length, MAX_TABLE_COLUMNS);
    const toRow = (line: string): NewRun[][] => {
      const cells = splitRow(line).slice(0, columns);
      while (cells.length < columns) cells.push("");
      return cells.map(cellRuns);
    };
    const rows: NewRun[][][] = [toRow(lines[start] as string)];
    let index = start + 2;
    while (index < lines.length) {
      const line = lines[index] as string;
      if (isBlank(line) || !line.includes("|")) break;
      if (rows.length >= MAX_TABLE_ROWS) throw new OfficeError("limit_exceeded", "a Markdown table has too many rows");
      rows.push(toRow(line));
      index++;
    }
    this.push({ type: "table", rows, header: true, alignments: alignments.slice(0, columns) });
    return index;
  }

  private listItem(item: RegExpExecArray): void {
    this.flush();
    const markerIndent = (item[1] as string).length;
    const marker = item[2] as string;
    const spacing = item[4] ?? " ";
    const contentColumn = markerIndent + marker.length + (spacing.length > 4 ? 1 : spacing.length);
    const ordered = item[3] !== undefined;
    let list = this.list;
    if (list === null) {
      list = { stack: [], numId: null, blankSeen: false };
      this.list = list;
    }
    list.blankSeen = false;
    const stack = list.stack;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as ListLevel;
      if (markerIndent >= top.contentColumn) break;
      if (markerIndent >= top.markerIndent || stack.length === 1) {
        stack.pop();
        break;
      }
      stack.pop();
    }
    stack.push({ markerIndent, contentColumn });
    const level = Math.min(stack.length - 1, MAX_LEVEL);
    let numId = BULLET_NUM_ID;
    if (ordered) {
      if (list.numId === null) {
        list.numId = this.nextNumId++;
        const start = level === 0 ? Math.min(Number.parseInt(item[3] as string, 10), MAX_START) : 1;
        this.decimalLists.push({ numId: list.numId, start });
      }
      numId = list.numId;
    }
    this.pending = { lines: [item[5] ?? ""], styleId: "ListParagraph", list: { numId, level } };
  }
}

/**
 * Parses Markdown into blocks. Ordered lists get numbering instances from
 * `firstNumId` upwards; bulleted lists use the shared bullet instance.
 */
export function parseMarkdown(markdown: string, firstNumId: number): MarkdownImport {
  if (typeof markdown !== "string") throw new OfficeError("invalid_argument", "markdown must be a string");
  if (markdown.length > MAX_MARKDOWN_LENGTH) throw new OfficeError("limit_exceeded", "the Markdown is too long");
  const lines = cleanFreeText(markdown).split("\n").map(expandTabs);
  const parser = new MarkdownParser(firstNumId);
  parser.run(lines);
  return { blocks: parser.blocks, decimalLists: parser.decimalLists };
}
