import { describe, expect, it } from "vitest";
import { canUseDesktopOperatorControls, normalizeDesktopOperators } from "../../packages/gateway/src/desktop/runtime-policy.js";

describe("desktop operator authorization", () => {
  it("allows the owner and configured operators while rejecting unsafe ids", () => {
    const operators = normalizeDesktopOperators(["user_456", "../bad", "user_789", "user_456"]);

    expect(operators).toEqual(["user_456", "user_789"]);
    expect(canUseDesktopOperatorControls({ ownerId: "user_123", principalUserId: "user_123", operatorIds: operators })).toBe(true);
    expect(canUseDesktopOperatorControls({ ownerId: "user_123", principalUserId: "user_456", operatorIds: operators })).toBe(true);
    expect(canUseDesktopOperatorControls({ ownerId: "user_123", principalUserId: "user_999", operatorIds: operators })).toBe(false);
  });
});
