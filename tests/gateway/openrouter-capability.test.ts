import { describe, expect, it } from "vitest";

import { isOpenRouterMultiHarnessEnabled } from "../../packages/gateway/src/ai-providers/openrouter-capability.js";

describe("OpenRouter multi-harness capability", () => {
  it("is enabled when the operational override is unset", () => {
    expect(isOpenRouterMultiHarnessEnabled(undefined)).toBe(true);
  });

  it("accepts an explicit enabled override", () => {
    expect(isOpenRouterMultiHarnessEnabled("1")).toBe(true);
  });

  it.each(["0", "", "true", "yes", " 1 "])(
    "fails closed for the explicit or malformed override %j",
    value => {
      expect(isOpenRouterMultiHarnessEnabled(value)).toBe(false);
    },
  );
});
