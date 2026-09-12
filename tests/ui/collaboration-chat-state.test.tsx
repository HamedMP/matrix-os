import { describe, expect, it } from "vitest";
import {
  createCollaborationDraftStore,
  collaborationDraftKey,
  collaborationDraftModeKey,
} from "../../packages/ui/src/collaboration/chat-state.js";
import { deriveChatPermissions } from "../../packages/ui/src/collaboration/permissions.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const scope = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "user_owner",
  kind: "chat" as const,
  resourceId: "chat_one",
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "1",
  authEpoch: "1",
  authorityGeneration: "1",
  role: "editor" as const,
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
};

describe("shared Chat client state", () => {
  it("keys drafts by actor, runtime, scope, and Chat and never crosses accounts", () => {
    const storage = new MemoryStorage();
    const drafts = createCollaborationDraftStore(storage);
    const editorKey = collaborationDraftKey({
      actorId: "user_editor", runtimeId: "vps:11111111-1111-4111-8111-111111111111",
      scopeId: scope.id, chatId: scope.resourceId,
    });
    const otherAccountKey = collaborationDraftKey({
      actorId: "user_other", runtimeId: "vps:11111111-1111-4111-8111-111111111111",
      scopeId: scope.id, chatId: scope.resourceId,
    });

    drafts.save(editorKey, { text: "private thought", mode: "discussion" });

    expect(drafts.load(editorKey)).toEqual({ text: "private thought", mode: "discussion" });
    expect(drafts.load(otherAccountKey)).toEqual({ text: "", mode: "discussion" });
    drafts.clear(editorKey);
    expect(drafts.load(editorKey)).toEqual({ text: "", mode: "discussion" });
  });

  it("keeps discussion and AI drafts separate for one actor and Chat", () => {
    const storage = new MemoryStorage();
    const drafts = createCollaborationDraftStore(storage);
    const base = collaborationDraftKey({
      actorId: "user_editor", runtimeId: "runtime", scopeId: scope.id, chatId: scope.resourceId,
    });
    const aiKey = collaborationDraftModeKey(base, "ai");

    drafts.save(base, { text: "for people", mode: "discussion" });
    drafts.save(aiKey, { text: "for AI", mode: "ai" });

    expect(drafts.load(base, "discussion")).toEqual({ text: "for people", mode: "discussion" });
    expect(drafts.load(aiKey, "ai")).toEqual({ text: "for AI", mode: "ai" });
  });

  it("caps retained draft records and rejects oversized draft content", () => {
    const storage = new MemoryStorage();
    const drafts = createCollaborationDraftStore(storage, { maxEntries: 2 });
    for (const actorId of ["user_one", "user_two", "user_three"]) {
      drafts.save(collaborationDraftKey({ actorId, runtimeId: "runtime", scopeId: scope.id, chatId: scope.resourceId }), {
        text: actorId,
        mode: "discussion",
      });
    }
    expect(storage.length).toBeLessThanOrEqual(3); // two records plus the bounded index
    expect(() => drafts.save(collaborationDraftKey({
      actorId: "user_four", runtimeId: "runtime", scopeId: scope.id, chatId: scope.resourceId,
    }), { text: "x".repeat(65_537), mode: "discussion" })).toThrow();
  });

  it("derives one viewer-safe presentation without enabling AI", () => {
    expect(deriveChatPermissions(scope)).toMatchObject({
      canDiscuss: true,
      canManageMembers: false,
      canRequestAi: false,
      composerExplanation: "Messages are shared with everyone in this Chat.",
    });
    expect(deriveChatPermissions({
      ...scope,
      role: "viewer",
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false },
    })).toMatchObject({
      canDiscuss: false,
      canRequestAi: false,
      composerExplanation: "Viewers can read this Chat but cannot post messages.",
    });
  });
});
