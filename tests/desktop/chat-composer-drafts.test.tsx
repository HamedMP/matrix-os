// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatComposerDrafts } from "@desktop/renderer/src/features/chat/use-chat-composer-drafts";

describe("Chat-bound composer drafts", () => {
  it("isolates text and references across Chats, new Chat, deletion, and runtime changes", () => {
    const firstClient = {};
    const secondClient = {};
    const view = renderHook(
      ({ clientIdentity, chatId, conversation }) => useChatComposerDrafts({
        clientIdentity,
        chatId,
        projectId: "matrix-os",
        conversation,
      }),
      { initialProps: { clientIdentity: firstClient, chatId: "chat_a", conversation: true } },
    );
    const reference = {
      type: "resource" as const,
      resource: { kind: "file" as const, id: "readme", label: "README.md" },
    };

    act(() => {
      view.result.current.setText("draft a");
      view.result.current.setReferenceTokens([reference]);
    });
    view.rerender({ clientIdentity: firstClient, chatId: "chat_b", conversation: true });
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([]);

    act(() => view.result.current.setText("draft b"));
    view.rerender({ clientIdentity: firstClient, chatId: "chat_a", conversation: true });
    expect(view.result.current.text).toBe("draft a");
    expect(view.result.current.referenceTokens).toEqual([reference]);

    act(() => view.result.current.prepareNewChatDraft({ text: "new draft" }));
    view.rerender({ clientIdentity: firstClient, chatId: null, conversation: false });
    expect(view.result.current.text).toBe("new draft");
    act(() => view.result.current.removeChatDraft("chat_a"));
    view.rerender({ clientIdentity: firstClient, chatId: "chat_a", conversation: true });
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([]);

    view.rerender({ clientIdentity: firstClient, chatId: "chat_b", conversation: true });
    expect(view.result.current.text).toBe("draft b");
    view.rerender({ clientIdentity: secondClient, chatId: "chat_b", conversation: true });
    expect(view.result.current.text).toBe("");
  });
});
