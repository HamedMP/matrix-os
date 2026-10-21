import { MAX_CHAT_DRAFTS, chatDraftKey, moveChatDraft, writeChatDraft } from "../lib/chat-drafts";

describe("chat drafts", () => {
  it("keys a chat's draft apart from the new chat's and from other chats'", () => {
    const keys = [chatDraftKey(null), chatDraftKey("chat_a"), chatDraftKey("chat_b"), chatDraftKey("new")];
    expect(new Set(keys).size).toBe(4);
  });

  it("writes one chat's draft without touching another's", () => {
    const drafts = writeChatDraft(writeChatDraft({}, "chat:a", "for A"), "chat:b", "for B");
    expect(drafts).toEqual({ "chat:a": "for A", "chat:b": "for B" });
    expect(writeChatDraft(drafts, "chat:a", "edited")).toEqual({ "chat:b": "for B", "chat:a": "edited" });
  });

  it("removes a draft that is emptied, and leaves the store alone when there was none", () => {
    const drafts = writeChatDraft({}, "chat:a", "for A");
    expect(writeChatDraft(drafts, "chat:a", "")).toEqual({});
    expect(writeChatDraft(drafts, "chat:b", "")).toBe(drafts);
  });

  it("drops the least recently written draft past the cap", () => {
    let drafts = {};
    for (let index = 0; index < MAX_CHAT_DRAFTS; index += 1) {
      drafts = writeChatDraft(drafts, `chat:${index}`, `draft ${index}`);
    }
    // Rewriting the oldest makes it the newest, so the next oldest goes.
    drafts = writeChatDraft(drafts, "chat:0", "kept");
    drafts = writeChatDraft(drafts, "chat:extra", "one more");

    expect(Object.keys(drafts)).toHaveLength(MAX_CHAT_DRAFTS);
    expect(drafts).toMatchObject({ "chat:0": "kept", "chat:extra": "one more" });
    expect(drafts).not.toHaveProperty("chat:1");
  });

  it("moves a draft to the chat created for it", () => {
    const drafts = writeChatDraft({}, chatDraftKey(null), "follow-up");
    expect(moveChatDraft(drafts, chatDraftKey(null), chatDraftKey("chat_new"))).toEqual({
      "chat:chat_new": "follow-up",
    });
    expect(moveChatDraft({}, chatDraftKey(null), chatDraftKey("chat_new"))).toEqual({});
  });
});
