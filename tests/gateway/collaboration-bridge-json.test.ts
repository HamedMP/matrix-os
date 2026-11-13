import { describe, expect, it } from "vitest";
import { BridgeJsonError, toBridgeJson } from "../../packages/gateway/src/collaboration/bridge-json.js";

const LIMIT = 1024;

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe("app bridge JSON wire conversion", () => {
  it("converts Postgres dates to the owner bridge ISO instant and keeps JSON shape", () => {
    const row = {
      id: "t1", done: false, score: 1.5, completed_at: null,
      created_at: new Date("2026-11-12T13:44:05.123Z"),
      history: [new Date("2026-01-01T00:00:00.000Z"), null],
      meta: { nested: { at: new Date(0) } },
    };
    const converted = toBridgeJson([row], LIMIT);
    expect(converted).toEqual([{
      id: "t1", done: false, score: 1.5, completed_at: null,
      created_at: "2026-11-12T13:44:05.123Z",
      history: ["2026-01-01T00:00:00.000Z", null],
      meta: { nested: { at: "1970-01-01T00:00:00.000Z" } },
    }]);
    expect(converted).toEqual(JSON.parse(JSON.stringify([row])));
  });

  it("keeps a JSONB __proto__ key as data instead of a prototype", () => {
    const converted = toBridgeJson(JSON.parse('{"__proto__":{"polluted":true}}'), LIMIT) as Record<string, unknown>;
    expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
    expect(Object.hasOwn(converted, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["NaN", Number.NaN, "non_finite_number"],
    ["Infinity", { value: Number.POSITIVE_INFINITY }, "non_finite_number"],
    ["invalid Date", [new Date("not a date")], "invalid_date"],
    ["bigint", { id: 1n }, "unsupported_type"],
    ["undefined field", { title: undefined }, "unsupported_type"],
    ["function", () => "x", "unsupported_type"],
    ["Buffer (bytea)", { blob: Buffer.from("secret") }, "unsupported_object"],
    ["Map", new Map([["a", 1]]), "unsupported_object"],
    ["class instance", { at: new URL("https://example.com") }, "unsupported_object"],
    ["deep nesting", nested(65), "too_deep"],
    ["oversized result", "x".repeat(LIMIT), "too_large"],
  ])("rejects %s without stringifying it", (_label, value, reason) => {
    expect(() => toBridgeJson(value, LIMIT)).toThrow(expect.objectContaining({ name: "BridgeJsonError", reason }));
  });

  it("accepts the size and depth boundaries exactly", () => {
    expect(toBridgeJson("x".repeat(LIMIT - 2), LIMIT)).toHaveLength(LIMIT - 2);
    expect(toBridgeJson(nested(64), LIMIT)).toEqual(nested(64));
    expect(() => toBridgeJson("x".repeat(LIMIT - 1), LIMIT)).toThrow(BridgeJsonError);
  });
});
