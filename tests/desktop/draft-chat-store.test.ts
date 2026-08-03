import { beforeEach, describe, expect, it } from "vitest";
import { AgentThreadComposerDraftSchema } from "@matrix-os/contracts";
import {
  clearDraftChats,
  MAX_DRAFT_CHAT_ENTRIES,
  useDraftChat,
} from "../../desktop/src/renderer/src/stores/draft-chat";

function draft(prompt: string) {
  return AgentThreadComposerDraftSchema.parse({ providerId: "codex", mode: "default", prompt });
}

describe("draft-chat store", () => {
  beforeEach(() => {
    clearDraftChats();
  });

  it("stores and returns a per-project draft", () => {
    useDraftChat.getState().setDraft("matrix-os", draft("hello"));
    expect(useDraftChat.getState().draftFor("matrix-os")?.prompt).toBe("hello");
    expect(useDraftChat.getState().draftFor("other")).toBeNull();
  });

  it("clears a project's draft without touching others", () => {
    useDraftChat.getState().setDraft("a", draft("one"));
    useDraftChat.getState().setDraft("b", draft("two"));
    useDraftChat.getState().clearDraft("a");
    expect(useDraftChat.getState().draftFor("a")).toBeNull();
    expect(useDraftChat.getState().draftFor("b")?.prompt).toBe("two");
  });

  it("evicts the coldest entries beyond the cap and keeps the freshest", () => {
    for (let index = 0; index < MAX_DRAFT_CHAT_ENTRIES; index += 1) {
      useDraftChat.getState().setDraft(`project-${index}`, draft(`d${index}`));
    }
    useDraftChat.getState().setDraft("project-new", draft("new"));
    const { entries } = useDraftChat.getState();
    expect(Object.keys(entries)).toHaveLength(MAX_DRAFT_CHAT_ENTRIES);
    expect(entries["project-new"]).toBeTruthy();
    expect(entries["project-0"]).toBeUndefined();
    expect(entries["project-1"]).toBeTruthy();
  });
});
