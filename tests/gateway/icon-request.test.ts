import { describe, expect, it } from "vitest";
import { isExplicitIconRegeneration } from "../../packages/gateway/src/icon-request.js";

describe("icon request policy", () => {
  it("requires an explicit regenerate flag before replacing shipped icons", () => {
    expect(isExplicitIconRegeneration(undefined)).toBe(false);
    expect(isExplicitIconRegeneration({})).toBe(false);
    expect(isExplicitIconRegeneration({ regenerate: false })).toBe(false);
    expect(isExplicitIconRegeneration({ regenerate: "true" })).toBe(false);
    expect(isExplicitIconRegeneration({ regenerate: true })).toBe(true);
  });
});
