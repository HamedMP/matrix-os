/** Writes a syntax tree back as formula text. */

import type { BinaryOperator } from "../../../api/formula.js";
import { cellText, rangeText, sheetPrefix, sheetSpanPrefix } from "./a1.js";
import type { ExtendedAst } from "./ast.js";

export interface SerializeOptions {
  /**
   * Writes the prefix a workbook file needs in front of newer functions
   * (`_xlfn.XLOOKUP`), so that other spreadsheet programs recognise them.
   * Use it for text stored in a file, not for text shown to a person.
   * Default false.
   */
  filePrefixes?: boolean;
}

const BINARY_POWER: Readonly<Record<BinaryOperator, number>> = {
  "^": 50,
  "*": 40,
  "/": 40,
  "+": 30,
  "-": 30,
  "&": 20,
  "=": 10,
  "<>": 10,
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
};
const REFERENCE_POWER = { ":": 90, " ": 85, ",": 80 } as const;
const PREFIX_POWER = 70;
const PERCENT_POWER = 60;
const ATOM_POWER = 100;

/** Functions newer than the original file format, which a file stores with a prefix. */
const PREFIXED_FUNCTIONS: ReadonlySet<string> = new Set([
  "CONCAT", "TEXTJOIN", "IFS", "SWITCH", "MAXIFS", "MINIFS", "XLOOKUP", "XMATCH", "IFNA", "XOR", "DAYS", "ISOWEEKNUM",
  "NUMBERVALUE", "UNICHAR", "UNICODE", "TEXTBEFORE", "TEXTAFTER", "TEXTSPLIT", "LET", "LAMBDA", "SEQUENCE", "RANDARRAY",
  "ISFORMULA", "SHEET", "SHEETS", "FORMULATEXT", "ARABIC", "BASE", "DECIMAL", "CEILING.MATH", "FLOOR.MATH",
  "STDEV.S", "STDEV.P", "VAR.S", "VAR.P", "MODE.SNGL", "PERCENTILE.INC", "PERCENTILE.EXC", "QUARTILE.INC",
  "QUARTILE.EXC", "RANK.EQ", "RANK.AVG",
]);
const WORKSHEET_PREFIXED_FUNCTIONS: ReadonlySet<string> = new Set(["FILTER", "SORT", "SORTBY", "UNIQUE"]);

function power(node: ExtendedAst): number {
  switch (node.type) {
    case "binary":
      return BINARY_POWER[node.op];
    case "unary":
      return node.op === "%" ? PERCENT_POWER : PREFIX_POWER;
    case "refop":
      return REFERENCE_POWER[node.op];
    case "number":
      return node.value < 0 || Object.is(node.value, -0) ? PREFIX_POWER : ATOM_POWER;
    default:
      return ATOM_POWER;
  }
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  if (Object.is(value, -0)) return "-0";
  return String(value).replace("e", "E");
}

function functionName(name: string, options: SerializeOptions): string {
  const upper = name.toUpperCase();
  if (options.filePrefixes !== true) return upper;
  if (PREFIXED_FUNCTIONS.has(upper)) return `_xlfn.${upper}`;
  if (WORKSHEET_PREFIXED_FUNCTIONS.has(upper)) return `_xlfn._xlws.${upper}`;
  return upper;
}

function write(node: ExtendedAst, options: SerializeOptions): string {
  switch (node.type) {
    case "number":
      return numberText(node.value);
    case "string":
      return `"${node.value.replace(/"/g, '""')}"`;
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "error":
      return node.code;
    case "missing":
      return "";
    case "cell":
      return sheetPrefix(node.sheet) + cellText(node);
    case "range":
      return sheetPrefix(node.sheet) + rangeText(node);
    case "ref3d":
      return sheetSpanPrefix(node.startSheet, node.endSheet) + (node.ref.type === "cell" ? cellText(node.ref) : rangeText(node.ref));
    case "name":
      return sheetPrefix(node.sheet) + node.name;
    case "paren":
      return `(${write(node.inner, options)})`;
    case "unary":
      if (node.op === "%") return `${operand(node.operand, PERCENT_POWER, options)}%`;
      return node.op + operand(node.operand, PREFIX_POWER, options);
    case "binary": {
      const level = BINARY_POWER[node.op];
      return operand(node.left, level, options) + node.op + operand(node.right, level + 1, options);
    }
    case "refop": {
      const level = REFERENCE_POWER[node.op];
      return operand(node.left, level, options) + node.op + operand(node.right, level + 1, options);
    }
    case "call": {
      const args = node.args.map((arg) => argument(arg, options));
      return `${functionName(node.name, options)}(${args.join(",")})`;
    }
    case "array":
      return `{${node.rows.map((row) => row.map((cell) => argument(cell, options)).join(",")).join(";")}}`;
  }
}

/** A child written with parentheses when it binds more loosely than its place needs. */
function operand(node: ExtendedAst, needed: number, options: SerializeOptions): string {
  const text = write(node, options);
  return power(node) < needed ? `(${text})` : text;
}

/** An argument or array element. A bare union gets parentheses: its comma would read as a separator. */
function argument(node: ExtendedAst, options: SerializeOptions): string {
  const text = write(node, options);
  return node.type === "refop" && node.op === "," ? `(${text})` : text;
}

/**
 * Writes a formula as text without the leading `=`. Function names are upper
 * case, sheet names are quoted when needed, white space is not kept, and
 * parentheses are added where a tree built by hand needs them. Parsing the
 * result of a parsed tree gives the same tree.
 */
export function serializeFormula(ast: ExtendedAst, options: SerializeOptions = {}): string {
  return write(ast, options);
}
