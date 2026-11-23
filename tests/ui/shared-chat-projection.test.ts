import { describe, expect, it } from "vitest";
import { sharedChatMembershipFromProjection } from "../../packages/ui/src/collaboration/chat-projection";
import { resolveCanonicalChatScope } from "../../packages/ui/src/collaboration/resolve-chat-scope";

describe("shared Chat canonical projection", () => {
  it("resolves the owner's project Chat when discovery lists the project instead of a standalone Chat", async () => {
    const scopeId = "10000000-0000-4000-8000-000000000001";
    const chatScope = "10000000-0000-4000-8000-000000000002";
    const api = { baseUrl: "https://app.matrix-os.com", post: async () => ({}), delete: async () => ({}),
      get: async (path: string) => path.endsWith("/project/overview") ? {
        scopeId, projectId: "project_shared", name: "Shared", status: "active",
        chats: [{ scopeId: chatScope, chatId: "chat_shared", title: "Chat", updatedAt: "2026-11-17T00:00:00Z" }],
      } : { items: [{ scopeId, runtimeId: "runtime_owner", ownerId: "owner", kind: "project",
        authorityGeneration: 1, status: "accepted", resource: {
          scope: { id: scopeId, ownerId: "owner", kind: "project", resourceId: "project_shared",
            membershipMode: "direct", lifecycle: "shared", role: "owner", revision: "1", authEpoch: "1",
            authorityGeneration: "1", capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true } },
          project: { id: "project_shared", scopeId, status: "active", resources: [] },
        } }] } };
    expect(await resolveCanonicalChatScope(api, "chat_shared", "project_shared")).toBe(chatScope);
  });
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
