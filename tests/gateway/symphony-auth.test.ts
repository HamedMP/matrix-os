import { describe, expect, it } from "vitest";
import { resolveSymphonyRole } from "../../packages/gateway/src/symphony/auth.js";

describe("Symphony auth helpers", () => {
  it("does not return an operator role for unauthorized principals", () => {
    expect(resolveSymphonyRole(
      { userId: "user_999", source: "jwt" },
      { ownerId: "user_123", authorizedOperators: ["user_456"] },
    )).toBeNull();
  });
});
