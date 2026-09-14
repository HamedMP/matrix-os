import { describe, expect, it, jest } from "@jest/globals";
import { loadCollaborationDraft, saveCollaborationDraft } from "@/lib/collaboration-drafts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
  };
}

describe("mobile collaboration drafts", () => {
  it("keeps drafts private to actor, scope, and Chat", async () => {
    const store = storage();
    await saveCollaborationDraft(store, { actorId: "actor-a", scopeId: "scope-a", chatId: "chat-a", text: "private" });
    await expect(loadCollaborationDraft(store, { actorId: "actor-a", scopeId: "scope-a", chatId: "chat-a" })).resolves.toBe("private");
    await expect(loadCollaborationDraft(store, { actorId: "actor-b", scopeId: "scope-a", chatId: "chat-a" })).resolves.toBe("");
  });

  it("caps stored drafts and evicts the least recently saved key", async () => {
    const store = storage();
    for (let index = 0; index < 21; index += 1) {
      await saveCollaborationDraft(store, {
        actorId: "actor", scopeId: `scope-${index}`, chatId: `chat-${index}`, text: `draft-${index}`,
      });
    }
    expect([...store.values.keys()].filter((key) => key.includes(":draft:")).length).toBe(20);
    await expect(loadCollaborationDraft(store, { actorId: "actor", scopeId: "scope-0", chatId: "chat-0" })).resolves.toBe("");
  });

  it("removes an empty draft", async () => {
    const store = storage();
    const identity = { actorId: "actor", scopeId: "scope", chatId: "chat" };
    await saveCollaborationDraft(store, { ...identity, text: "draft" });
    await saveCollaborationDraft(store, { ...identity, text: "" });
    await expect(loadCollaborationDraft(store, identity)).resolves.toBe("");
  });
});
