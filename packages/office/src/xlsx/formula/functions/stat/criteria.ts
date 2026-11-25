/**
 * Criteria matching for COUNTIF, SUMIF, AVERAGEIF, their *IFS forms,
 * MAXIFS and MINIFS.
 *
 * A criterion is a value or text that starts with an operator:
 * - a number matches equal numbers and text that reads as that number;
 *   `">5"`, `"<=2024-01-31"` compare with numeric cells only.
 * - `TRUE`/`FALSE` (or the text) matches that boolean.
 * - text matches text without regard to case, with the wildcards `?` (one
 *   character) and `*` (any run of characters); `~` escapes `?`, `*` and `~`.
 *   `"<b"` and the other order operators compare text with text.
 * - `""` matches blank cells and empty text, `"="` only blank cells,
 *   `"<>"` every cell that is not blank.
 * - `"<>x"` matches every cell that `"=x"` does not, blanks and errors included.
 * - an error value or error text matches cells holding that error.
 * - a blank criterion (a reference to an empty cell) is the number 0.
 */

import type { FormulaErrorCode, FormulaScalar } from "../../../../api/formula.js";
import { ERROR_CODES, compareValues, isError, parseNumberText } from "../../coerce.js";

export type Criterion = (cell: FormulaScalar) => boolean;

type Operator = "=" | "<>" | "<" | "<=" | ">" | ">=";

const OPERATOR = /^(<=|>=|<>|=|<|>)/;
/** Longest pattern text the matcher accepts; longer patterns match nothing. */
const MAX_PATTERN_LENGTH = 1024;

function ordered(op: Operator, order: number): boolean {
  switch (op) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
    default:
      return order !== 0;
  }
}

function negate(op: Operator, equal: Criterion): Criterion {
  return op === "<>" ? (cell) => !equal(cell) : equal;
}

type Token = { kind: "char"; ch: string } | { kind: "one" } | { kind: "any" };

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === "~" && i + 1 < pattern.length && "?*~".includes(pattern[i + 1] as string)) {
      tokens.push({ kind: "char", ch: pattern[i + 1] as string });
      i += 1;
    } else if (ch === "?") tokens.push({ kind: "one" });
    else if (ch === "*") tokens.push({ kind: "any" });
    else tokens.push({ kind: "char", ch });
  }
  return tokens;
}

/**
 * Whole-text wildcard match without regular expressions: a linear scan
 * that backtracks only to the last `*`, so no pattern can blow up.
 */
function wildcardMatcher(pattern: string): (text: string) => boolean {
  const tokens = tokenize(pattern.toUpperCase());
  const plain = tokens.every((token) => token.kind === "char");
  if (plain) {
    const literal = tokens.map((token) => (token.kind === "char" ? token.ch : "")).join("");
    return (text) => text.toUpperCase() === literal;
  }
  return (input) => {
    const text = input.toUpperCase();
    let t = 0;
    let p = 0;
    let star = -1;
    let resume = 0;
    while (t < text.length) {
      const token = tokens[p];
      if (token !== undefined && (token.kind === "one" || (token.kind === "char" && token.ch === text[t]))) {
        t += 1;
        p += 1;
      } else if (token !== undefined && token.kind === "any") {
        star = p;
        resume = t;
        p += 1;
      } else if (star !== -1) {
        p = star + 1;
        resume += 1;
        t = resume;
      } else {
        return false;
      }
    }
    while (p < tokens.length && (tokens[p] as Token).kind === "any") p += 1;
    return p === tokens.length;
  };
}

function numberCriterion(op: Operator, operand: number, date1904: boolean): Criterion {
  if (op === "=" || op === "<>") {
    return negate(op, (cell) => {
      if (typeof cell === "number") return compareValues(cell, operand) === 0;
      if (typeof cell === "string") {
        const parsed = parseNumberText(cell, { date1904 });
        return parsed !== null && compareValues(parsed, operand) === 0;
      }
      return false;
    });
  }
  return (cell) => typeof cell === "number" && ordered(op, compareValues(cell, operand));
}

function booleanCriterion(op: Operator, operand: boolean): Criterion {
  if (op === "=" || op === "<>") return negate(op, (cell) => cell === operand);
  return (cell) => typeof cell === "boolean" && ordered(op, compareValues(cell, operand));
}

function errorCriterion(op: Operator, code: FormulaErrorCode): Criterion {
  const equal: Criterion = (cell) => isError(cell) && cell.code === code;
  return op === "=" || op === "<>" ? negate(op, equal) : () => false;
}

function textCriterion(op: Operator, operand: string): Criterion {
  if (op === "=" || op === "<>") {
    if (operand.length > MAX_PATTERN_LENGTH) return negate(op, () => false);
    const matches = wildcardMatcher(operand);
    return negate(op, (cell) => typeof cell === "string" && matches(cell));
  }
  return (cell) => typeof cell === "string" && ordered(op, compareValues(cell, operand));
}

function emptyCriterion(op: Operator, hadOperator: boolean): Criterion {
  if (op === "<>") return (cell) => cell !== null;
  if (op === "=") return hadOperator ? (cell) => cell === null : (cell) => cell === null || cell === "";
  return (cell) => typeof cell === "string" && ordered(op, compareValues(cell, ""));
}

/** Turns a criterion argument into a predicate over cell values. */
export function parseCriterion(criterion: FormulaScalar, options: { date1904?: boolean } = {}): Criterion {
  const date1904 = options.date1904 === true;
  if (criterion === null) return numberCriterion("=", 0, date1904);
  if (typeof criterion === "number") return numberCriterion("=", criterion, date1904);
  if (typeof criterion === "boolean") return booleanCriterion("=", criterion);
  if (isError(criterion)) return errorCriterion("=", criterion.code);
  const match = OPERATOR.exec(criterion);
  const op = (match === null ? "=" : match[1]) as Operator;
  const operand = match === null ? criterion : criterion.slice(op.length);
  if (operand === "") return emptyCriterion(op, match !== null);
  const number = parseNumberText(operand, { date1904 });
  if (number !== null) return numberCriterion(op, number, date1904);
  const upper = operand.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return booleanCriterion(op, upper === "TRUE");
  const code = ERROR_CODES.find((candidate) => candidate === upper);
  if (code !== undefined) return errorCriterion(op, code);
  return textCriterion(op, operand);
}
