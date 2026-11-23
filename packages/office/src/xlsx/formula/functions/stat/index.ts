/** Statistical functions: counts, averages, spread, order statistics and the conditional aggregates. */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerBasicStatistics } from "./basic.js";
import { registerConditionalFunctions } from "./conditional.js";
import { registerOrderStatistics } from "./order.js";

export { parseCriterion, type Criterion } from "./criteria.js";
export * from "./compute.js";
export { gridOf, resizedGrid, sameShape, usedRegion, type Grid } from "./grid.js";
export { countNumbers, countValues } from "./basic.js";

export function registerStatisticalFunctions(registry: FunctionRegistry): void {
  registerBasicStatistics(registry);
  registerOrderStatistics(registry);
  registerConditionalFunctions(registry);
}
