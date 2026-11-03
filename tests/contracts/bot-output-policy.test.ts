import { expect, it } from "vitest";
import { botOutputEncodedBytes, botOutputPrefix } from "@matrix-os/contracts";

it("retains a complete four-byte character when it exactly fits the encoded budget", () => {
  expect(botOutputPrefix("🧪", 4)).toBe("🧪");
  expect(botOutputPrefix("🧪tail", 4)).toBe("🧪");
  expect(botOutputPrefix("🧪tail", 3)).toBe("");
});

it("counts JSON escapes and keeps every returned prefix within the budget", () => {
  const text = 'a\n🧪"\\\u0000tail';
  for (let size = 0; size < 30; size++) {
    const prefix = botOutputPrefix(text, size);
    expect(text.startsWith(prefix)).toBe(true);
    expect(botOutputEncodedBytes(prefix)).toBeLessThanOrEqual(size);
    expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/u);
  }
  expect(botOutputPrefix(text, 100)).toBe(text);
});
