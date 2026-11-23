/**
 * Syntax tree of the full formula grammar.
 *
 * The contract tree (`FormulaAst` in `api/formula.ts`) covers what
 * `parseFormula` accepts. {@link ExtendedAst} adds the two things the
 * contract leaves out: the reference operators and references across a span
 * of sheets. `parseFormulaExtended` produces it, and every helper of this
 * module (serialise, collect, map, rewrite, evaluate) accepts both.
 */

import type {
  BinaryOperator,
  BooleanNode,
  CellNode,
  ErrorNode,
  FormulaAst,
  MissingNode,
  NameNode,
  NumberNode,
  RangeNode,
  StringNode,
  UnaryOperator,
} from "../../../api/formula.js";

/** Last zero-based row of a sheet. */
export const MAX_ROW = 1_048_575;
/** Last zero-based column of a sheet (`XFD`). */
export const MAX_COL = 16_383;
/** Longest formula text that is parsed, in UTF-16 code units. */
export const MAX_FORMULA_LENGTH = 8192;
/** Deepest syntax tree the parser builds. A longer chain or deeper nesting is `limit_exceeded`. */
export const MAX_AST_DEPTH = 1024;
/** Most arguments of one function call. */
export const MAX_CALL_ARGS = 255;

/** `:` builds the range between two references, a space intersects them, `,` joins them. */
export type ReferenceOperator = ":" | " " | ",";

/**
 * A reference operator that could not be folded into a plain range:
 * `A1:INDEX(B:B,3)`, `Sales Q1` (intersection), `(A1:A3,C1:C3)` (union).
 */
export interface ReferenceOperatorNode {
  type: "refop";
  op: ReferenceOperator;
  left: ExtendedAst;
  right: ExtendedAst;
}

/** A reference to the same cells on every sheet from `startSheet` to `endSheet`: `Jan:Mar!B2`. */
export interface SheetSpanNode {
  type: "ref3d";
  startSheet: string;
  endSheet: string;
  /** The cells on each sheet. Its own `sheet` is always null. */
  ref: CellNode | RangeNode;
}

export interface ExtendedUnaryNode {
  type: "unary";
  op: UnaryOperator;
  operand: ExtendedAst;
}
export interface ExtendedBinaryNode {
  type: "binary";
  op: BinaryOperator;
  left: ExtendedAst;
  right: ExtendedAst;
}
export interface ExtendedCallNode {
  type: "call";
  name: string;
  args: ExtendedAst[];
}
export interface ExtendedArrayNode {
  type: "array";
  rows: ExtendedAst[][];
}
export interface ExtendedParenNode {
  type: "paren";
  inner: ExtendedAst;
}

/** A tree of the full grammar. Every `FormulaAst` is an `ExtendedAst`. */
export type ExtendedAst =
  | NumberNode
  | StringNode
  | BooleanNode
  | ErrorNode
  | CellNode
  | RangeNode
  | NameNode
  | MissingNode
  | ExtendedUnaryNode
  | ExtendedBinaryNode
  | ExtendedCallNode
  | ExtendedArrayNode
  | ExtendedParenNode
  | ReferenceOperatorNode
  | SheetSpanNode;

/** True when the tree uses nothing beyond the contract grammar, so it is a `FormulaAst`. */
export function isContractAst(ast: ExtendedAst): ast is FormulaAst {
  switch (ast.type) {
    case "refop":
    case "ref3d":
      return false;
    case "unary":
      return isContractAst(ast.operand);
    case "binary":
      return isContractAst(ast.left) && isContractAst(ast.right);
    case "call":
      return ast.args.every(isContractAst);
    case "array":
      return ast.rows.every((row) => row.every(isContractAst));
    case "paren":
      return isContractAst(ast.inner);
    default:
      return true;
  }
}

/**
 * True for a node that can stand for cells: a reference, a name, a function
 * call (INDEX and OFFSET return references), or those in parentheses.
 */
export function isReferenceLike(ast: ExtendedAst): boolean {
  switch (ast.type) {
    case "cell":
    case "range":
    case "name":
    case "call":
    case "refop":
    case "ref3d":
      return true;
    case "paren":
      return isReferenceLike(ast.inner);
    case "error":
      return ast.code === "#REF!";
    default:
      return false;
  }
}
