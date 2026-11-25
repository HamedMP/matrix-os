/** Formula evaluation: the evaluator, the operators and the reference helpers. */

export { DEFAULT_MAX_CELLS, DEFAULT_MAX_DEPTH, evaluate } from "./evaluator.js";
export type { EvaluateOptions } from "./evaluator.js";
export { MAX_TEXT_LENGTH, applyBinary, applyUnary, binaryScalar, unaryScalar } from "./operators.js";
export type { OperatorOptions } from "./operators.js";
export {
  boundsArea,
  boundsIntersection,
  boundsOfNode,
  boundsUnion,
  readReference,
  referenceOf,
  toCellResult,
  validBounds,
  valueAt,
} from "./reference.js";
export { registerCoreFunctions } from "./core-functions.js";
