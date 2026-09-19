import { describe, expect, it } from "vitest";
import { sharedChatMembershipFromProjection } from "../../packages/ui/src/collaboration/chat-projection";

describe("shared Chat canonical projection", () => {
  it("accepts the normalized backend projection used to enter collaborative Chat", () => {
    expect(sharedChatMembershipFromProjection({
      mode: "shared",
      membership: {
        role: "editor",
        memberCount: 2,
      },
    })).toEqual({ role: "editor", memberCount: 2 });
  });

  it.each([
    { mode: "private" },
    { mode: "shared" },
    { mode: "shared", membership: { role: "owner", memberCount: 0 } },
    { mode: "shared", membership: { role: "admin", memberCount: 2 } },
  ])("fails closed for incomplete or private projection %#", (projection) => {
    expect(sharedChatMembershipFromProjection(projection)).toBeNull();
  });
});
