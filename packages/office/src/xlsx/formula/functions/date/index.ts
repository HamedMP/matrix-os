/** The date and time function library (serial numbers, 1900 or 1904 system). */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { registerBasicDateFunctions } from "./basic.js";
import { registerCalendarFunctions } from "./calendar.js";
import { registerWorkdayFunctions } from "./workdays.js";

export { nowSerial, parseDateText } from "./parse.js";
export { dayArg, serialArg } from "./serial.js";

/** Registers DATE through YEARFRAC. */
export function registerDateFunctions(registry: FunctionRegistry): void {
  registerBasicDateFunctions(registry);
  registerCalendarFunctions(registry);
  registerWorkdayFunctions(registry);
}
