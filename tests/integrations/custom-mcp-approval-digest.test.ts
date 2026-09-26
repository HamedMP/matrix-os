import { describe, expect, it } from "vitest";
import { customMcpArgumentsDigest } from "../../packages/gateway/src/integrations/custom-mcp/approval-digest.js";

describe("Custom MCP approval argument binding", () => {
  it("uses stable JSON object order but preserves array order and values", () => {
    expect(customMcpArgumentsDigest({ a: { y: 2, x: 1 }, z: ["one", "two"] }))
      .toBe(customMcpArgumentsDigest({ z: ["one", "two"], a: { x: 1, y: 2 } }));
    expect(customMcpArgumentsDigest({ z: ["two", "one"], a: { x: 1, y: 2 } }))
      .not.toBe(customMcpArgumentsDigest({ z: ["one", "two"], a: { x: 1, y: 2 } }));
    expect(customMcpArgumentsDigest({ amount: 1 })).not.toBe(customMcpArgumentsDigest({ amount: "1" }));
  });

  it("rejects non-JSON, cyclic, deep, and oversized input before a challenge", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      { broken: undefined }, { broken: Number.NaN }, { broken: Infinity },
      cyclic, { tooLarge: "x".repeat(66_000) },
    ]) expect(() => customMcpArgumentsDigest(value)).toThrow();
    let deep: unknown = "leaf";
    for (let index = 0; index < 25; index++) deep = { next: deep };
    expect(() => customMcpArgumentsDigest({ deep })).toThrow();
  });
});
