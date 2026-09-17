import { describe, expect, it } from "vitest";
import { sharedChatScopeFromProjection } from "../../packages/ui/src/collaboration/chat-projection";

const scopeId = "10000000-0000-4000-8000-000000000001";

describe("shared Chat canonical projection", () => {
  it("accepts the normalized backend projection used to enter collaborative Chat", () => {
    expect(sharedChatScopeFromProjection({
      mode: "shared",
      scopeId,
      membership: {
        role: "editor",
        memberCount: 2,
        capabilities: { requestAi: true },
      },
    })).toEqual({ scopeId, role: "editor", memberCount: 2, requestAi: true });
  });

  it.each([
    { mode: "private" },
    { mode: "shared", membership: { role: "owner", memberCount: 2, capabilities: { requestAi: true } } },
    { mode: "shared", scopeId: "not-a-scope", membership: { role: "owner", memberCount: 2, capabilities: { requestAi: true } } },
    { mode: "shared", scopeId, membership: { role: "owner", memberCount: 2 } },
  ])("fails closed for incomplete or private projection %#", (projection) => {
    expect(sharedChatScopeFromProjection(projection)).toBeNull();
  });
});
