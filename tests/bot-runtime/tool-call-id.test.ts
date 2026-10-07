import { describe, expect, it } from "vitest";
import { bridgeToolCallId } from "../../packages/bot-runtime/src/tool-call-id.js";

describe("broker tool-call IDs", () => {
  it.each(["call_write", "A.b:c-d_0", "a".repeat(128)])("preserves valid IDs: %s", (id) => {
    expect(bridgeToolCallId(id)).toBe(id);
  });

  it("maps composite Pi IDs deterministically without forwarding the original", () => {
    const id = "call_write|fc_item_1";
    const expected = "call_dccaeae1358650916bbee4bce1dcb6fa436cee72d8b4eacd222cc18e5c299a18";
    expect(bridgeToolCallId(id)).toBe(expected);
    expect(bridgeToolCallId(id)).toBe(expected);
    expect(expected).not.toContain(id);
  });

  it("hashes the complete ID rather than dropping a component, truncating, or normalizing", () => {
    const ids = [
      "call_write|fc_item_1", "call_write|fc_item_2", "call_read|fc_item_1",
      `${"a".repeat(128)}|first`, `${"a".repeat(128)}|second`, "call_é|item", "call_e\u0301|item",
    ];
    const mapped = ids.map(bridgeToolCallId);
    expect(new Set(mapped).size).toBe(ids.length);
    for (const id of mapped) expect(id).toMatch(/^call_[a-f0-9]{64}$/);
  });

  it.each(["", "|", "_leading", "a".repeat(129), "call\nsecret", "call/unsafe", "call\n", "call\r", "call\u2028", "call\u2029", `${"a".repeat(128)}\n`])("bounds unsafe IDs", (id) => {
    expect(bridgeToolCallId(id)).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
    expect(bridgeToolCallId(id)).toHaveLength(69);
  });
});
