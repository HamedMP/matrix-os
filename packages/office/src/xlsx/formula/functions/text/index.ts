/** The text function library. */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerTextFormatFunctions } from "./format.js";
import { registerStringFunctions } from "./strings.js";

export { hasWildcard, wildcardMatcher, wildcardSearch } from "./wildcard.js";
export { roundHalfAway, textToNumber } from "./format.js";

/** Registers CONCAT through DOLLAR. */
export function registerTextFunctions(registry: FunctionRegistry): void {
  registerStringFunctions(registry);
  registerTextFormatFunctions(registry);
}
