/**
 * A run without a time.
 *
 * A formula with a saved value is calculated as usual, but the functions that
 * need the time (TODAY, NOW) stop its calculation by throwing {@link NO_CLOCK}.
 * Nothing in the engine catches it: the evaluator turns only a `RangeError`
 * into a value, and functions that handle errors (IFERROR, ISERROR, ...) look
 * at values, not exceptions. So a calculation that finishes never used the
 * time and gives the answer the formula has at any time, while one that is
 * stopped needed the time, and the formula keeps the value it was saved with.
 * Branches a formula does not take are not calculated and so do not count.
 */

import type { FunctionRegistry, RegisteredFunction } from "../../api/formula.js";

/** Functions that need the time of the run. */
const CLOCK_FUNCTIONS = ["NOW", "TODAY"] as const;

class NoClock extends Error {}

/** Thrown by the functions that need the time in a run without one. */
export const NO_CLOCK: Error = new NoClock("the calculation needs a time and none was given");

function stop(): never {
  throw NO_CLOCK;
}

/** The functions of `functions`, with those that need the time throwing {@link NO_CLOCK} when called. */
export function clocklessFunctions(functions: FunctionRegistry): FunctionRegistry {
  const stopped = new Map<string, RegisteredFunction>();
  for (const name of CLOCK_FUNCTIONS) {
    const fn = functions.get(name);
    // The number of arguments is still checked first: TODAY(1) gives #VALUE! at any time.
    if (fn !== null) stopped.set(name, { name: fn.name, minArgs: fn.minArgs, maxArgs: fn.maxArgs, volatile: fn.volatile, lazy: true, impl: stop });
  }
  return {
    register: (name, impl, options) => functions.register(name, impl, options),
    registerLazy: (name, impl, options) => functions.registerLazy(name, impl, options),
    get: (name) => stopped.get(name.toUpperCase()) ?? functions.get(name),
    has: (name) => functions.has(name),
    names: () => functions.names(),
  };
}
