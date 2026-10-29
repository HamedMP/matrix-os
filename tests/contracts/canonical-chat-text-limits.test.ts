import { describe, expect, it } from "vitest";
import { canonicalBoundedText, canonicalSafeLabel } from "../../packages/contracts/src/canonical-chat-primitives.js";

describe("canonical chat text budgets", () => {
  it.each([
    { label: "ASCII", boundary: "a".repeat(1_000), overflow: "a".repeat(1_001) },
    { label: "surrogate pairs", boundary: "😀".repeat(500), overflow: "😀".repeat(500) + "a" },
  ])("preserves the UTF-16 boundary for $label", ({ boundary, overflow }) => {
    const schema = canonicalSafeLabel(1_000, 4_000);
    expect(schema.safeParse(boundary).success).toBe(true);
    expect(schema.safeParse(overflow).success).toBe(false);
  });

  it("keeps byte limits and blank rejection independent of character limits", () => {
    const schema = canonicalBoundedText(100, 8);
    expect(schema.safeParse("😀😀").success).toBe(true);
    expect(schema.safeParse("😀😀a").success).toBe(false);
    expect(schema.safeParse("   ").success).toBe(false);
  });
});
