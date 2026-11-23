import { describe, expect, it } from "vitest";
import type { FunctionRegistry } from "../../../../../packages/office/src/api/formula.js";
import { isOfficeError } from "../../../../../packages/office/src/errors.js";
import {
  MAX_REGISTERED_FUNCTIONS,
  acceptsRange,
  createRegistry,
  normalizeFunctionName,
  registerAll,
  registerFunction,
  registerLazyFunction,
} from "../../../../../packages/office/src/xlsx/formula/registry.js";

const one = () => 1;

describe("function registry", () => {
  it("stores names in upper case and finds them in any case", () => {
    const registry = createRegistry();
    registry.register("double", ([n]) => (typeof n === "number" ? n * 2 : null));
    expect(registry.has("DOUBLE")).toBe(true);
    expect(registry.has("Double")).toBe(true);
    expect(registry.has("TRIPLE")).toBe(false);
    expect(registry.get("double")?.name).toBe("DOUBLE");
    expect(registry.get("nope")).toBeNull();
  });

  it("strips the file prefixes of newer functions", () => {
    const registry = createRegistry();
    registry.register("_xlfn.XLOOKUP", one);
    registry.register("_xlfn._xlws.FILTER", one);
    expect(registry.names()).toEqual(["FILTER", "XLOOKUP"]);
    expect(registry.has("_xlfn.xlookup")).toBe(true);
    expect(normalizeFunctionName(" log10 ")).toBe("LOG10");
    expect(normalizeFunctionName("ERROR.TYPE")).toBe("ERROR.TYPE");
  });

  it("applies the default metadata", () => {
    const registry = createRegistry();
    registry.register("F", one);
    expect(registry.get("F")).toMatchObject({ name: "F", minArgs: 0, maxArgs: null, volatile: false, lazy: false });
    expect(registry.describe("F")?.acceptsRange(3)).toBe(true);
  });

  it("keeps argument bounds, volatility and the lazy flag", () => {
    const registry = createRegistry();
    registry.register("RANDX", one, { minArgs: 0, maxArgs: 0, volatile: true });
    registry.registerLazy("PICK", () => null, { minArgs: 2, maxArgs: 5 });
    expect(registry.get("RANDX")).toMatchObject({ minArgs: 0, maxArgs: 0, volatile: true, lazy: false });
    expect(registry.get("PICK")).toMatchObject({ minArgs: 2, maxArgs: 5, volatile: false, lazy: true });
    expect(registry.describe("PICK")?.lazy).toBe(true);
    expect(registry.describe("MISSING")).toBeNull();
  });

  it("records which arguments accept ranges", () => {
    const registry = createRegistry();
    registry.register("ALLR", one);
    registry.register("NONE", one, { ranges: "none" });
    registry.register("FIRST", one, { ranges: [0] });
    registry.register("EVEN", one, { ranges: (i) => i % 2 === 0 });
    registry.registerLazy("LAZY", () => null);
    const probe = (name: string) => [0, 1, 2].map((i) => acceptsRange(registry.get(name)!, i));
    expect(probe("ALLR")).toEqual([true, true, true]);
    expect(probe("NONE")).toEqual([false, false, false]);
    expect(probe("FIRST")).toEqual([true, false, false]);
    expect(probe("EVEN")).toEqual([true, false, true]);
    expect(probe("LAZY")).toEqual([true, true, true]);
  });

  it("treats a function from a foreign registry as accepting ranges everywhere", () => {
    expect(acceptsRange({ name: "X", minArgs: 0, maxArgs: null, volatile: false, lazy: false, impl: one }, 1)).toBe(true);
  });

  it("replaces a function registered under the same name", () => {
    const registry = createRegistry();
    registry.register("F", () => 1);
    registry.registerLazy("f", () => 2, { minArgs: 1 });
    expect(registry.size).toBe(1);
    expect(registry.get("F")).toMatchObject({ lazy: true, minArgs: 1 });
    expect(registry.unregister("f")).toBe(true);
    expect(registry.unregister("f")).toBe(false);
    expect(registry.names()).toEqual([]);
  });

  it("lists names sorted", () => {
    const registry = createRegistry();
    for (const name of ["SUM", "ABS", "MAX"]) registry.register(name, one);
    expect(registry.names()).toEqual(["ABS", "MAX", "SUM"]);
  });

  it.each(["", "  ", "1ABC", "A B", "A(", "A!B", "x".repeat(256)])("rejects the name %j", (name) => {
    const registry = createRegistry();
    let thrown: unknown;
    try {
      registry.register(name, one);
    } catch (error) {
      thrown = error;
    }
    expect(isOfficeError(thrown, "invalid_argument")).toBe(true);
  });

  it("rejects impossible argument bounds", () => {
    const registry = createRegistry();
    expect(() => registry.register("F", one, { minArgs: 2, maxArgs: 1 })).toThrowError(/argument bounds/);
    expect(() => registry.register("F", one, { minArgs: -1 })).toThrowError(/argument bounds/);
    expect(() => registry.register("F", one, { minArgs: 1.5 })).toThrowError(/argument bounds/);
    expect(() => registry.register("F", one, { ranges: [-1] })).toThrowError(/zero-based/);
    expect(registry.size).toBe(0);
  });

  it("is bounded", () => {
    const registry = createRegistry();
    for (let i = 0; i < MAX_REGISTERED_FUNCTIONS; i += 1) registry.register(`F${i}`, one);
    let thrown: unknown;
    try {
      registry.register("ONE_MORE", one);
    } catch (error) {
      thrown = error;
    }
    expect(isOfficeError(thrown, "limit_exceeded")).toBe(true);
    registry.register("F0", () => 2);
    expect(registry.size).toBe(MAX_REGISTERED_FUNCTIONS);
  });
});

describe("registerAll and the helpers", () => {
  it("runs libraries in order so that a later one wins", () => {
    const first = (registry: FunctionRegistry) => {
      registerFunction(registry, "A", () => 1, { ranges: "none" });
      registerFunction(registry, "B", () => 1);
    };
    const second = (registry: FunctionRegistry) => {
      registerFunction(registry, "B", () => 2, { minArgs: 1 });
      registerLazyFunction(registry, "C", () => 3, { volatile: true });
    };
    const registry = registerAll(createRegistry(), [first, second]);
    expect(registry.names()).toEqual(["A", "B", "C"]);
    expect(registry.get("B")?.minArgs).toBe(1);
    expect(registry.get("C")).toMatchObject({ lazy: true, volatile: true });
    expect(acceptsRange(registry.get("A")!, 0)).toBe(false);
  });
});
