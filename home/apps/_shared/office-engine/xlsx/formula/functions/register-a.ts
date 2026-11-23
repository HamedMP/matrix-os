/**
 * Function library A: math, statistical, logical and information functions.
 *
 * `registerA` first registers the engine's core functions (SUM, IF,
 * IFERROR, AND, OR, NOT) so that a registry built from this library alone
 * is complete, then the four groups. Add it to `FUNCTION_LIBRARIES` in
 * `../index.ts` (or pass it to `registerAll`).
 */

import type { FunctionRegistry } from "../../../api/formula.js";
import { registerCoreFunctions } from "../eval/core-functions.js";
import { registerInformationFunctions } from "./info/index.js";
import { registerLogicalFunctions } from "./logical/index.js";
import { registerMathFunctions } from "./math/index.js";
import { registerStatisticalFunctions } from "./stat/index.js";

export { registerInformationFunctions, registerLogicalFunctions, registerMathFunctions, registerStatisticalFunctions };

export function registerA(registry: FunctionRegistry): void {
  registerCoreFunctions(registry);
  registerMathFunctions(registry);
  registerStatisticalFunctions(registry);
  registerLogicalFunctions(registry);
  registerInformationFunctions(registry);
}
