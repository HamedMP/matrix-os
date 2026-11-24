/**
 * The operators of the formula language on values.
 *
 * Each works on scalars and, element by element, on arrays. An error
 * operand is the result; for two errors the left one wins.
 */

import type {
  BinaryOperator,
  FormulaScalar,
  FormulaValue,
  UnaryOperator,
} from "../../../api/formula.js";
import { ERR, broadcast, compareValues, isError, makeError, toNumber, toText } from "../coerce.js";

/** Longest text a cell holds; a longer `&` result is `#VALUE!`. */
export const MAX_TEXT_LENGTH = 32_767;

export interface OperatorOptions {
  /** True for the 1904 date system, for text that holds a date. */
  date1904?: boolean;
  /** Most cells an array result may have. */
  maxCells?: number;
}

function arithmetic(op: "+" | "-" | "*" | "/" | "^", a: FormulaScalar, b: FormulaScalar, options: OperatorOptions): FormulaScalar {
  const x = toNumber(a, options);
  if (isError(x)) return x;
  const y = toNumber(b, options);
  if (isError(y)) return y;
  let result: number;
  switch (op) {
    case "+":
      result = x + y;
      break;
    case "-":
      result = x - y;
      break;
    case "*":
      result = x * y;
      break;
    case "/":
      if (y === 0) return ERR.DIV0;
      result = x / y;
      break;
    case "^":
      if (x === 0 && y === 0) return ERR.NUM;
      if (x === 0 && y < 0) return ERR.DIV0;
      result = x ** y;
      break;
  }
  if (!Number.isFinite(result)) return ERR.NUM;
  return result === 0 ? 0 : result;
}

/** A binary operator on two scalars. */
export function binaryScalar(op: BinaryOperator, a: FormulaScalar, b: FormulaScalar, options: OperatorOptions = {}): FormulaScalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "^":
      return arithmetic(op, a, b, options);
    case "&": {
      const left = toText(a) as string;
      const right = toText(b) as string;
      if (left.length + right.length > MAX_TEXT_LENGTH) return makeError("#VALUE!", "text is too long");
      return left + right;
    }
    case "=":
      return compareValues(a, b) === 0;
    case "<>":
      return compareValues(a, b) !== 0;
    case "<":
      return compareValues(a, b) < 0;
    case ">":
      return compareValues(a, b) > 0;
    case "<=":
      return compareValues(a, b) <= 0;
    case ">=":
      return compareValues(a, b) >= 0;
  }
}

/** A unary operator on a scalar. Unary plus leaves its operand as it is. */
export function unaryScalar(op: UnaryOperator, value: FormulaScalar, options: OperatorOptions = {}): FormulaScalar {
  if (op === "+" || isError(value)) return value;
  const n = toNumber(value, options);
  if (isError(n)) return n;
  if (op === "-") return n === 0 ? 0 : -n;
  return n / 100;
}

/** A binary operator on two values, element by element for arrays. */
export function applyBinary(op: BinaryOperator, left: FormulaValue, right: FormulaValue, options: OperatorOptions = {}): FormulaValue {
  return broadcast([left, right], (s) => binaryScalar(op, s[0] as FormulaScalar, s[1] as FormulaScalar, options), options.maxCells);
}

/** A unary operator on a value, element by element for an array. */
export function applyUnary(op: UnaryOperator, value: FormulaValue, options: OperatorOptions = {}): FormulaValue {
  return broadcast([value], (s) => unaryScalar(op, s[0] as FormulaScalar, options), options.maxCells);
}
