/**
 * Function library B: text, date and time, lookup and reference, and
 * financial functions. Add `registerB` to `FUNCTION_LIBRARIES` in
 * `../index.ts`; it may run before or after other libraries, and a later
 * library replaces any function registered here under the same name.
 */

import type { FunctionRegistry } from "../../../api/formula.js";
import { registerDateFunctions } from "./date/index.js";
import { registerFinancialFunctions } from "./financial/index.js";
import { registerLookupFunctions } from "./lookup/index.js";
import { registerTextFunctions } from "./text/index.js";

export { registerDateFunctions, registerFinancialFunctions, registerLookupFunctions, registerTextFunctions };

/** Registers every function of library B. */
export function registerB(registry: FunctionRegistry): void {
  registerTextFunctions(registry);
  registerDateFunctions(registry);
  registerLookupFunctions(registry);
  registerFinancialFunctions(registry);
}
