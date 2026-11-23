/**
 * The function registry of the formula engine.
 *
 * A function library is a function that receives a registry and registers
 * its functions. `registerAll` runs a list of libraries:
 *
 * ```ts
 * import type { FunctionRegistry } from "../../../api/formula.js";
 * import { ERR, collectNumbers, isError, toNumber } from "../coerce.js";
 * import { registerFunction } from "../registry.js";
 *
 * export function registerMathFunctions(registry: FunctionRegistry): void {
 *   // Scalar function: `ranges: "none"` hands every argument over as a
 *   // scalar and applies the function element by element to arrays.
 *   registerFunction(registry, "ABS", ([value]) => {
 *     const n = toNumber(value ?? null);
 *     return isError(n) ? n : Math.abs(n);
 *   }, { minArgs: 1, maxArgs: 1, ranges: "none" });
 *
 *   // Aggregate: every argument may be a range (the default).
 *   registerFunction(registry, "PRODUCT", (args) => {
 *     const numbers = collectNumbers(args);
 *     return isError(numbers) ? numbers : numbers.reduce((a, b) => a * b, 1);
 *   }, { minArgs: 1 });
 * }
 * ```
 *
 * What an eager function receives ({@link FunctionImpl}):
 * - Arguments are evaluated first. An argument left empty arrives as `null`.
 * - An argument that accepts ranges (see {@link RangeArguments}) arrives as
 *   it was evaluated: a cell or range reference is a `FormulaArray` with
 *   `ref` set (a single cell is 1 by 1), an array constant or array result
 *   is a `FormulaArray` with `ref` null, anything else is a scalar.
 * - An argument that does not accept ranges always arrives as a scalar. When
 *   such an argument is an array of several cells, the engine calls the
 *   function once per element and returns a computed array.
 * - Errors are passed in, not filtered: a function that should fail on an
 *   error argument returns it (`firstError(args)` finds it).
 * - A number result that is `NaN` or infinite is turned into `#NUM!`.
 *
 * A lazy function ({@link LazyFunctionImpl}) receives the argument syntax
 * trees and `context.evaluate`. It decides what to evaluate (IF, CHOOSE) or
 * reads the reference itself (ROW, OFFSET): evaluating a reference node gives
 * a `FormulaArray` whose `ref` holds the bounds.
 *
 * The engine checks the number of arguments before calling a function:
 * fewer than `minArgs` or more than `maxArgs` is `#VALUE!`. A function that
 * is not registered is `#NAME?`.
 */

import type {
  FunctionImpl,
  FunctionOptions,
  FunctionRegistry,
  LazyFunctionImpl,
  RegisteredFunction,
} from "../../api/formula.js";
import { OfficeError } from "../../errors.js";

/**
 * Which arguments of an eager function take a range or array as a whole.
 * - `"all"` (default): every argument.
 * - `"none"`: no argument; the function works on scalars and is applied
 *   element by element to arrays.
 * - a list of zero-based argument positions, for example `[0]` for a
 *   function whose first argument is a range and whose others are scalars.
 * - a predicate over the zero-based position, for functions with repeating
 *   argument groups (`(i) => i % 2 === 0`).
 */
export type RangeArguments = "all" | "none" | readonly number[] | ((index: number) => boolean);

/** {@link FunctionOptions} with the argument metadata this engine understands. */
export interface FunctionSpec extends FunctionOptions {
  /** Which arguments accept ranges. Ignored for a lazy function. Default `"all"`. */
  ranges?: RangeArguments;
}

/** Everything the registry knows about a function. */
export interface FunctionInfo {
  /** Upper case. */
  name: string;
  minArgs: number;
  /** Null for no maximum. */
  maxArgs: number | null;
  volatile: boolean;
  lazy: boolean;
  /** True when the argument at the zero-based position accepts a range or array as a whole. Always true for a lazy function. */
  acceptsRange(index: number): boolean;
}

/** A {@link FunctionRegistry} that also keeps the argument metadata. */
export interface CoreFunctionRegistry extends FunctionRegistry {
  register(name: string, impl: FunctionImpl, options?: FunctionSpec): void;
  registerLazy(name: string, impl: LazyFunctionImpl, options?: FunctionSpec): void;
  /** Metadata of a function, or null when it is not registered. */
  describe(name: string): FunctionInfo | null;
  /** Removes a function. Returns false when there was none. */
  unregister(name: string): boolean;
  /** Number of registered functions. */
  readonly size: number;
}

/** A function library: registers its functions in the registry it is given. */
export type FunctionLibrary = (registry: FunctionRegistry) => void;

/** The most functions one registry holds. */
export const MAX_REGISTERED_FUNCTIONS = 4096;

const FUNCTION_NAME = /^[A-Z_][A-Z0-9_.]*$/;
const NAME_PREFIX = /^(?:_XLFN\.)?(?:_XLWS\.)?/;
const ALWAYS = (): boolean => true;
const NEVER = (): boolean => false;

/**
 * The stored form of a function name: upper case, without the `_xlfn.` and
 * `_xlws.` prefixes that a file puts in front of newer functions.
 * Throws `invalid_argument` for a name that cannot be a function name.
 */
export function normalizeFunctionName(name: string): string {
  const upper = String(name).trim().toUpperCase().replace(NAME_PREFIX, "");
  if (upper.length === 0 || upper.length > 255 || !FUNCTION_NAME.test(upper)) {
    throw new OfficeError("invalid_argument", "invalid function name", { details: { length: String(name).length } });
  }
  return upper;
}

function rangePredicate(ranges: RangeArguments | undefined): (index: number) => boolean {
  if (ranges === undefined || ranges === "all") return ALWAYS;
  if (ranges === "none") return NEVER;
  if (typeof ranges === "function") return (index) => ranges(index) === true;
  const positions = [...ranges];
  for (const position of positions) {
    if (!Number.isInteger(position) || position < 0) {
      throw new OfficeError("invalid_argument", "ranges must list zero-based argument positions");
    }
  }
  return (index) => positions.includes(index);
}

function argumentBounds(name: string, options: FunctionSpec): { minArgs: number; maxArgs: number | null } {
  const minArgs = options.minArgs ?? 0;
  const maxArgs = options.maxArgs ?? null;
  const valid =
    Number.isInteger(minArgs) && minArgs >= 0 && (maxArgs === null || (Number.isInteger(maxArgs) && maxArgs >= minArgs));
  if (!valid) {
    throw new OfficeError("invalid_argument", `invalid argument bounds for ${name}`, {
      details: { name, minArgs, maxArgs },
    });
  }
  return { minArgs, maxArgs };
}

type StoredFunction = RegisteredFunction & { acceptsRange(index: number): boolean };

class Registry implements CoreFunctionRegistry {
  // Bounded by MAX_REGISTERED_FUNCTIONS in store().
  private readonly functions = new Map<string, StoredFunction>();

  get size(): number {
    return this.functions.size;
  }

  register(name: string, impl: FunctionImpl, options: FunctionSpec = {}): void {
    const key = normalizeFunctionName(name);
    if (typeof impl !== "function") throw new OfficeError("invalid_argument", `${key} needs an implementation`);
    this.store({
      name: key,
      ...argumentBounds(key, options),
      volatile: options.volatile === true,
      lazy: false,
      impl,
      acceptsRange: rangePredicate(options.ranges),
    });
  }

  registerLazy(name: string, impl: LazyFunctionImpl, options: FunctionSpec = {}): void {
    const key = normalizeFunctionName(name);
    if (typeof impl !== "function") throw new OfficeError("invalid_argument", `${key} needs an implementation`);
    this.store({
      name: key,
      ...argumentBounds(key, options),
      volatile: options.volatile === true,
      lazy: true,
      impl,
      acceptsRange: ALWAYS,
    });
  }

  get(name: string): RegisteredFunction | null {
    return this.lookup(name);
  }

  has(name: string): boolean {
    return this.lookup(name) !== null;
  }

  names(): string[] {
    return [...this.functions.keys()].sort();
  }

  describe(name: string): FunctionInfo | null {
    const found = this.lookup(name);
    if (found === null) return null;
    return {
      name: found.name,
      minArgs: found.minArgs,
      maxArgs: found.maxArgs,
      volatile: found.volatile,
      lazy: found.lazy,
      acceptsRange: found.acceptsRange,
    };
  }

  unregister(name: string): boolean {
    return this.functions.delete(String(name).trim().toUpperCase().replace(NAME_PREFIX, ""));
  }

  private lookup(name: string): StoredFunction | null {
    if (typeof name !== "string") return null;
    const direct = this.functions.get(name);
    if (direct !== undefined) return direct;
    return this.functions.get(name.trim().toUpperCase().replace(NAME_PREFIX, "")) ?? null;
  }

  private store(entry: StoredFunction): void {
    if (!this.functions.has(entry.name) && this.functions.size >= MAX_REGISTERED_FUNCTIONS) {
      throw new OfficeError("limit_exceeded", "too many registered functions", {
        details: { max: MAX_REGISTERED_FUNCTIONS },
      });
    }
    this.functions.set(entry.name, entry);
  }
}

/** Creates an empty registry. `createFunctionRegistry` in `index.ts` creates one with the function library. */
export function createRegistry(): CoreFunctionRegistry {
  return new Registry();
}

/**
 * Registers an eager function with argument metadata in any registry.
 * A registry created by this engine keeps `ranges`; another implementation
 * of {@link FunctionRegistry} receives the options it knows.
 */
export function registerFunction(
  registry: FunctionRegistry,
  name: string,
  impl: FunctionImpl,
  options: FunctionSpec = {},
): void {
  registry.register(name, impl, options);
}

/** Registers a lazy function in any registry. */
export function registerLazyFunction(
  registry: FunctionRegistry,
  name: string,
  impl: LazyFunctionImpl,
  options: FunctionOptions = {},
): void {
  registry.registerLazy(name, impl, options);
}

/**
 * Whether the argument at a zero-based position accepts a range or array as
 * a whole. True for a function registered without metadata.
 */
export function acceptsRange(fn: RegisteredFunction, index: number): boolean {
  if (fn.lazy) return true;
  const predicate = (fn as Partial<StoredFunction>).acceptsRange;
  return typeof predicate === "function" ? predicate(index) : true;
}

/**
 * Runs every library against the registry, in order: a later library
 * replaces a function an earlier one registered under the same name.
 * Returns the registry.
 */
export function registerAll<R extends FunctionRegistry>(registry: R, libraries: readonly FunctionLibrary[]): R {
  for (const library of libraries) library(registry);
  return registry;
}
