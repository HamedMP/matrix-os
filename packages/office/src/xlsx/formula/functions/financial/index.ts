/** The financial function library. */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerCashFlowFunctions } from "./cashflow.js";
import { registerTimeValueFunctions } from "./tvm.js";

export { solveRate } from "./solve.js";

/** Registers PMT through SLN. */
export function registerFinancialFunctions(registry: FunctionRegistry): void {
  registerTimeValueFunctions(registry);
  registerCashFlowFunctions(registry);
}
