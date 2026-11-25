/** Math functions: aggregates, rounding, elementary functions, trigonometry, SUBTOTAL and AGGREGATE. */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerAggregates } from "./aggregate.js";
import { registerArithmetic } from "./arith.js";
import { registerSubtotals } from "./subtotal.js";
import { registerTrigonometry } from "./trig.js";

export { clean, registerNumeric, roundTo, shiftDecimal, type NumericSpec, type RoundMode } from "./scalar.js";

export function registerMathFunctions(registry: FunctionRegistry): void {
  registerAggregates(registry);
  registerArithmetic(registry);
  registerTrigonometry(registry);
  registerSubtotals(registry);
}
