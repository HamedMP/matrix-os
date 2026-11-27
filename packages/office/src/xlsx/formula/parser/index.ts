/**
 * Formula syntax: parsing, writing back and rewriting references.
 * See `parser.ts` for the grammar and `rewrite.ts` for the reference helpers.
 */

export {
  MAX_AST_DEPTH,
  MAX_CALL_ARGS,
  MAX_COL,
  MAX_FORMULA_LENGTH,
  MAX_ROW,
  isContractAst,
  isReferenceLike,
} from "./ast.js";
export type {
  ExtendedArrayNode,
  ExtendedAst,
  ExtendedBinaryNode,
  ExtendedCallNode,
  ExtendedParenNode,
  ExtendedUnaryNode,
  ReferenceOperator,
  ReferenceOperatorNode,
  SheetSpanNode,
} from "./ast.js";
export {
  cellText,
  columnIndex,
  columnLabel,
  inSheet,
  normalizeCorners,
  quoteSheetName,
  rangeText,
  sameSheet,
  sheetNameNeedsQuotes,
  sheetPrefix,
} from "./a1.js";
export { parseFormula, parseFormulaExtended } from "./parser.js";
export { serializeFormula } from "./serialize.js";
export type { SerializeOptions } from "./serialize.js";
export { collectFunctionNames, collectReferences, mapReferences, transformNodes, visitNodes } from "./walk.js";
export { rewriteFormulaText, rewriteReferences, shiftFormulaText, shiftReferences } from "./rewrite.js";
export type { ReferenceChange } from "./rewrite.js";
