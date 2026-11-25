/** The lookup and reference function library. */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerArrayFunctions } from "./arrays.js";
import { registerSearchFunctions } from "./lookup.js";
import { registerReferenceFunctions } from "./reference.js";

export {
  approximateIndex,
  exactIndex,
  exactPredicate,
  shapeOf,
  vectorOf,
  xmatchIndex,
  type MatchMode,
  type SearchMode,
  type Vector,
} from "./match.js";
export { materialize, sliceArray } from "./slice.js";

/** Registers VLOOKUP through FILTER. */
export function registerLookupFunctions(registry: FunctionRegistry): void {
  registerSearchFunctions(registry);
  registerReferenceFunctions(registry);
  registerArrayFunctions(registry);
}
