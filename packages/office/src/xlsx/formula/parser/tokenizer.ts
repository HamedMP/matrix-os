/**
 * Splits formula text into tokens.
 *
 * References are recognised here, with their sheet: a cell (`$A$1`), a whole
 * column or row range (`A:C`, `2:5`), a sheet prefix (`Sheet1!`,
 * `'My sheet'!`, `Jan:Mar!`). A range of two cells (`A1:B2`) is put together
 * by the parser from the `:` operator.
 */

import type { CellNode, FormulaErrorCode, RangeNode } from "../../../api/formula.js";
import { OfficeError } from "../../../errors.js";
import { columnIndex, sheetNameNeedsQuotes } from "./a1.js";
import { MAX_COL, MAX_ROW, type SheetSpanNode } from "./ast.js";

export type OperatorText =
  | "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=" | "%" | ":" | "," | ";" | "(" | ")" | "{" | "}";

interface TokenBase {
  /** Position of the first character in the text given to the parser. */
  offset: number;
  /** True when white space comes before the token. */
  space: boolean;
}

export type Token = TokenBase &
  (
    | { kind: "number"; value: number }
    | { kind: "string"; value: string }
    | { kind: "boolean"; value: boolean }
    | { kind: "error"; code: FormulaErrorCode }
    | { kind: "ref"; node: CellNode | RangeNode | SheetSpanNode }
    | { kind: "name"; name: string; sheet: string | null }
    /** A function name; the `(` after it is part of the token. */
    | { kind: "func"; name: string }
    | { kind: "op"; op: OperatorText }
    | { kind: "eof" }
  );

/** Throws the parse error of the formula engine. `offset` counts UTF-16 code units from the start of the text. */
export function syntaxError(message: string, offset: number): never {
  throw new OfficeError("formula_error", `${message} at offset ${offset}`, { details: { offset } });
}

const ERROR_LITERALS: readonly FormulaErrorCode[] = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#NULL!", "#N/A"];
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const ROW_RANGE = /(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\p{L}\p{N}_.$])/uy;
const COLUMN_RANGE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\p{L}\p{N}_.\\?$(!:])/uy;
const CELL = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\p{L}\p{N}_.\\?(!])/uy;
const IDENTIFIER = /[\p{L}_\\][\p{L}\p{N}_.\\?]*/uy;
const SHEET_PREFIX = /([\p{L}_][\p{L}\p{N}_.]*)(?::([\p{L}_][\p{L}\p{N}_.]*))?!/uy;
const IDENTIFIER_START = /[\p{L}_\\]/u;
const FUNCTION_PREFIX = /^(?:_XLFN\.)?(?:_XLWS\.)?/;
const TWO_CHAR_OPERATORS: readonly OperatorText[] = ["<>", "<=", ">="];
const ONE_CHAR_OPERATORS = "+-*/^&=<>%:,;(){}";

interface SheetQualifier {
  start: string;
  /** Last sheet of a span, or null for one sheet. */
  end: string | null;
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

class Tokenizer {
  private pos: number;
  private readonly tokens: Token[] = [];

  constructor(
    private readonly text: string,
    start: number,
  ) {
    this.pos = start;
  }

  run(): Token[] {
    const { text } = this;
    for (;;) {
      let space = false;
      while (this.pos < text.length && isSpace(text.charCodeAt(this.pos))) {
        this.pos += 1;
        space = true;
      }
      const offset = this.pos;
      if (offset >= text.length) {
        this.tokens.push({ kind: "eof", offset, space });
        return this.tokens;
      }
      this.next(text.charAt(offset), offset, space);
    }
  }

  private next(ch: string, offset: number, space: boolean): void {
    const { text } = this;
    if (ch === '"') return this.readString(offset, space);
    if (ch === "#") return this.readError(offset, space);
    if (ch === "'") return this.readReference(this.readQuotedSheet(offset), offset, space);
    if (ch === "[") syntaxError("references to other workbooks and tables are not supported", offset);
    if (ch >= "0" && ch <= "9") {
      if (this.tryRowRange(null, offset, space)) return;
      return this.readNumber(offset, space);
    }
    if (ch === ".") return this.readNumber(offset, space);
    if (ch === "$" || IDENTIFIER_START.test(ch)) {
      const prefix = ch === "$" ? null : matchAt(SHEET_PREFIX, text, offset);
      // `A1:Sheet2!B2` is a cell, a colon and a reference, not a span of sheets called A1 and Sheet2.
      const span = prefix !== null && prefix[2] !== undefined;
      if (prefix !== null && !(span && sheetNameNeedsQuotes(prefix[1] as string))) {
        this.pos = offset + prefix[0].length;
        return this.readReference({ start: prefix[1] as string, end: prefix[2] ?? null }, offset, space);
      }
      return this.readReference(null, offset, space);
    }
    for (const op of TWO_CHAR_OPERATORS) {
      if (text.startsWith(op, offset)) {
        this.pos = offset + 2;
        this.tokens.push({ kind: "op", op, offset, space });
        return;
      }
    }
    if (ONE_CHAR_OPERATORS.includes(ch)) {
      this.pos = offset + 1;
      this.tokens.push({ kind: "op", op: ch as OperatorText, offset, space });
      return;
    }
    syntaxError(`unexpected character ${JSON.stringify(ch)}`, offset);
  }

  private readString(offset: number, space: boolean): void {
    const { text } = this;
    let value = "";
    let i = offset + 1;
    for (;;) {
      const close = text.indexOf('"', i);
      if (close === -1) syntaxError("unterminated string", offset);
      value += text.slice(i, close);
      if (text.charAt(close + 1) === '"') {
        value += '"';
        i = close + 2;
        continue;
      }
      this.pos = close + 1;
      this.tokens.push({ kind: "string", value, offset, space });
      return;
    }
  }

  private readError(offset: number, space: boolean): void {
    const rest = this.text.slice(offset, offset + 8).toUpperCase();
    for (const code of ERROR_LITERALS) {
      if (rest.startsWith(code)) {
        this.pos = offset + code.length;
        this.tokens.push({ kind: "error", code, offset, space });
        return;
      }
    }
    syntaxError("unknown error literal", offset);
  }

  private readNumber(offset: number, space: boolean): void {
    const match = matchAt(NUMBER, this.text, offset);
    if (match === null) syntaxError("unexpected character \".\"", offset);
    const value = Number(match[0]);
    if (!Number.isFinite(value)) syntaxError("number is out of range", offset);
    this.pos = offset + match[0].length;
    this.tokens.push({ kind: "number", value, offset, space });
  }

  /** Reads `'My sheet'!` or `'Jan:Mar'!` and leaves the position after the `!`. */
  private readQuotedSheet(offset: number): SheetQualifier {
    const { text } = this;
    let name = "";
    let i = offset + 1;
    for (;;) {
      const close = text.indexOf("'", i);
      if (close === -1) syntaxError("unterminated sheet name", offset);
      name += text.slice(i, close);
      if (text.charAt(close + 1) === "'") {
        name += "'";
        i = close + 2;
        continue;
      }
      i = close + 1;
      break;
    }
    if (text.charAt(i) !== "!") syntaxError("expected ! after the sheet name", i);
    if (name.length === 0) syntaxError("empty sheet name", offset);
    if (name.includes("[") || name.includes("]")) syntaxError("references to other workbooks are not supported", offset);
    this.pos = i + 1;
    const colon = name.indexOf(":");
    if (colon === -1) return { start: name, end: null };
    const start = name.slice(0, colon);
    const end = name.slice(colon + 1);
    if (start.length === 0 || end.length === 0 || end.includes(":")) syntaxError("invalid sheet range", offset);
    return { start, end };
  }

  /** Reads what follows an optional sheet prefix: a cell, a column or row range, an error, a name or a function. */
  private readReference(sheet: SheetQualifier | null, offset: number, space: boolean): void {
    const { text } = this;
    const at = this.pos;
    if (sheet !== null && text.charAt(at) === "#") {
      if (text.slice(at, at + 5).toUpperCase() !== "#REF!") syntaxError("expected a reference after the sheet name", at);
      this.pos = at + 5;
      this.tokens.push({ kind: "error", code: "#REF!", offset, space });
      return;
    }
    if (this.tryRowRange(sheet, offset, space)) return;
    const columns = matchAt(COLUMN_RANGE, text, at);
    if (columns !== null) {
      const startCol = columnIndex(columns[2] as string);
      const endCol = columnIndex(columns[4] as string);
      if (startCol >= 0 && endCol >= 0) {
        this.pos = at + columns[0].length;
        const first = { row: 0, col: startCol, rowAbsolute: true, colAbsolute: columns[1] === "$" };
        const second = { row: MAX_ROW, col: endCol, rowAbsolute: true, colAbsolute: columns[3] === "$" };
        const [start, end] = startCol <= endCol ? [first, second] : [{ ...second, row: 0 }, { ...first, row: MAX_ROW }];
        return this.pushReference({ type: "range", sheet: null, shape: "columns", start, end }, sheet, offset, space);
      }
    }
    const cell = matchAt(CELL, text, at);
    if (cell !== null) {
      const col = columnIndex(cell[2] as string);
      const row = Number(cell[4]) - 1;
      if (col >= 0 && row >= 0 && row <= MAX_ROW) {
        this.pos = at + cell[0].length;
        const node: CellNode = { type: "cell", sheet: null, row, col, rowAbsolute: cell[3] === "$", colAbsolute: cell[1] === "$" };
        return this.pushReference(node, sheet, offset, space);
      }
    }
    const identifier = matchAt(IDENTIFIER, text, at);
    if (identifier === null) {
      syntaxError(sheet === null ? "invalid reference" : "expected a reference after the sheet name", at);
    }
    const name = identifier[0];
    const after = at + name.length;
    const following = text.charAt(after);
    if (following === "[") syntaxError("structured table references are not supported", after);
    if (following === "!") syntaxError("invalid sheet name", at);
    if (following === "(") {
      if (sheet !== null) syntaxError("a function cannot have a sheet name", offset);
      this.pos = after + 1;
      this.tokens.push({ kind: "func", name: name.toUpperCase().replace(FUNCTION_PREFIX, ""), offset, space });
      return;
    }
    this.pos = after;
    if (sheet === null) {
      const upper = name.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        this.tokens.push({ kind: "boolean", value: upper === "TRUE", offset, space });
        return;
      }
    } else if (sheet.end !== null) {
      syntaxError("a name cannot span sheets", offset);
    }
    this.tokens.push({ kind: "name", name, sheet: sheet === null ? null : sheet.start, offset, space });
  }

  private tryRowRange(sheet: SheetQualifier | null, offset: number, space: boolean): boolean {
    const rows = matchAt(ROW_RANGE, this.text, this.pos);
    if (rows === null) return false;
    const a = Number(rows[2]) - 1;
    const b = Number(rows[4]) - 1;
    if (a < 0 || b < 0 || a > MAX_ROW || b > MAX_ROW) return false;
    this.pos += rows[0].length;
    const first = { row: a, col: 0, rowAbsolute: rows[1] === "$", colAbsolute: true };
    const second = { row: b, col: MAX_COL, rowAbsolute: rows[3] === "$", colAbsolute: true };
    const [start, end] = a <= b ? [first, second] : [{ ...second, col: 0 }, { ...first, col: MAX_COL }];
    this.pushReference({ type: "range", sheet: null, shape: "rows", start, end }, sheet, offset, space);
    return true;
  }

  private pushReference(node: CellNode | RangeNode, sheet: SheetQualifier | null, offset: number, space: boolean): void {
    if (sheet === null) {
      this.tokens.push({ kind: "ref", node, offset, space });
    } else if (sheet.end === null) {
      this.tokens.push({ kind: "ref", node: { ...node, sheet: sheet.start }, offset, space });
    } else {
      const span: SheetSpanNode = { type: "ref3d", startSheet: sheet.start, endSheet: sheet.end, ref: node };
      this.tokens.push({ kind: "ref", node: span, offset, space });
    }
  }
}

/** Tokens of `text` from `start` on, ending with an `eof` token. Throws `formula_error` with the offset. */
export function tokenize(text: string, start = 0): Token[] {
  return new Tokenizer(text, start).run();
}
