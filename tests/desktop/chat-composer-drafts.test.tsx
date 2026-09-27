// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatComposerDrafts } from "@desktop/renderer/src/features/chat/use-chat-composer-drafts";

describe("Chat-bound composer drafts", () => {
  it("clears an abandoned new-Chat draft without changing existing Chat drafts", () => {
    const clientIdentity = {};
    const view = renderHook(
      ({ chatId, conversation }: { chatId: string | null; conversation: boolean }) => useChatComposerDrafts({
        clientIdentity, chatId, projectId: "matrix-os", conversation,
      }),
      { initialProps: { chatId: "chat_a", conversation: true } },
    );
    const reference = {
      type: "resource" as const,
      resource: { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper", revision: "3" },
    };
    act(() => {
      view.result.current.setText("Existing Chat draft");
      view.result.current.setReferenceTokens([reference]);
      view.result.current.prepareNewChatDraft({ text: "Abandoned new draft", referenceTokens: [reference] });
    });
    view.rerender({ chatId: null, conversation: false });
    const abandonedIdentity = view.result.current.requestIdentity;
    act(() => view.result.current.prepareNewChatDraft());
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([]);
    expect(view.result.current.requestIdentity).not.toBe(abandonedIdentity);
    view.rerender({ chatId: "chat_a", conversation: true });
    expect(view.result.current.text).toBe("Existing Chat draft");
    expect(view.result.current.referenceTokens).toEqual([reference]);
  });

  it("starts partial replacement drafts without inheriting prior text or references", () => {
    const clientIdentity = {};
    const view = renderHook(() => useChatComposerDrafts({
      clientIdentity, chatId: null, projectId: "matrix-os", conversation: false,
    }));
    const reference = {
      type: "resource" as const,
      resource: { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" },
    };
    act(() => view.result.current.prepareNewChatDraft({ text: "Old request", referenceTokens: [reference] }));
    act(() => view.result.current.prepareNewChatDraft({ text: "Replacement app request" }));
    expect(view.result.current.text).toBe("Replacement app request");
    expect(view.result.current.referenceTokens).toEqual([]);
    act(() => view.result.current.prepareNewChatDraft({ referenceTokens: [reference] }));
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([reference]);
  });

  it("rotates request identity on draft replacement and preserves it while editing", () => {
    const clientIdentity = {};
    const view = renderHook(() => useChatComposerDrafts({
      clientIdentity, chatId: null, projectId: "matrix-os", conversation: false,
    }));
    const initial = view.result.current.requestIdentity;
    act(() => view.result.current.prepareNewChatDraft({ text: "First request" }));
    const first = view.result.current.requestIdentity;
    expect(first).not.toBe(initial);
    act(() => view.result.current.setText("First request with more detail"));
    expect(view.result.current.requestIdentity).toBe(first);
    act(() => view.result.current.prepareNewChatDraft({ text: "Replacement request" }));
    expect(view.result.current.requestIdentity).not.toBe(first);
  });

  it("applies delayed transcript inserts to the latest typed draft", () => {
    const view = renderHook(() => useChatComposerDrafts({
      clientIdentity: "client",
      chatId: "chat_a",
      projectId: null,
      conversation: true,
    }));
    const reference = {
      type: "resource" as const,
      resource: { kind: "file" as const, id: "notes", label: "notes.md" },
    };
    act(() => {
      view.result.current.setText("typed while transcribing");
      view.result.current.setReferenceTokens([reference]);
      view.result.current.setText((current) => `${current} spoken draft`);
    });
    expect(view.result.current.text).toBe("typed while transcribing spoken draft");
    expect(view.result.current.referenceTokens).toEqual([reference]);
  });

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
  it("settles text and references atomically only at the captured draft revision", () => {
    const view = renderHook(() => useChatComposerDrafts({ clientIdentity: "client", chatId: "chat_a", projectId: null, conversation: true }));
    const reference = { type: "resource" as const, resource: { kind: "file" as const, id: "notes", label: "notes.md" } };
    act(() => { view.result.current.setText("original"); view.result.current.setReferenceTokens([reference]); });
    const revision = view.result.current.revision;
    act(() => view.result.current.updateIfUnchanged(revision, { text: "", referenceTokens: [] }));
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([]);
    const cleared = view.result.current.revision;
    act(() => { view.result.current.setText("newer"); view.result.current.setText(""); view.result.current.setReferenceTokens([reference]); });
    act(() => view.result.current.updateIfUnchanged(cleared, { text: "original", referenceTokens: [] }));
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([reference]);
  });

  it("settles the captured draft after identical text and fresh arrays of unchanged token objects", () => {
    const view = renderHook(() => useChatComposerDrafts({ clientIdentity: "client", chatId: "chat_a", projectId: null, conversation: true }));
    const reference = { type: "resource" as const, resource: { kind: "file" as const, id: "notes", label: "notes.md" } };
    act(() => { view.result.current.setText("original"); view.result.current.setReferenceTokens([reference]); });
    const submitted = view.result.current;
    act(() => { view.result.current.setText("original"); view.result.current.setReferenceTokens([reference]); });
    expect(view.result.current.revision).toBe(submitted.revision);
    act(() => submitted.updateIfUnchanged(submitted.revision, { text: "", referenceTokens: [] }));
    expect(view.result.current.text).toBe("");
    expect(view.result.current.referenceTokens).toEqual([]);
  });

  it.each(["text edit", "text retype", "token identity", "token order"] as const)(
    "preserves a newer draft after %s when an older admission clears its captured revision",
    (change) => {
      const view = renderHook(() => useChatComposerDrafts({ clientIdentity: "client", chatId: "chat_a", projectId: null, conversation: true }));
      const first = { type: "resource" as const, resource: { kind: "file" as const, id: "first", label: "first.md" } };
      const second = { type: "resource" as const, resource: { kind: "file" as const, id: "second", label: "second.md" } };
      const replacement = { type: "resource" as const, resource: { kind: "file" as const, id: "replacement", label: "first.md" } };
      act(() => { view.result.current.setText("original"); view.result.current.setReferenceTokens([first, second]); });
      const submitted = view.result.current;
      act(() => {
        if (change === "text edit" || change === "text retype") view.result.current.setText("newer");
        if (change === "text retype") view.result.current.setText("original");
        if (change === "token identity") view.result.current.setReferenceTokens([replacement, second]);
        if (change === "token order") view.result.current.setReferenceTokens([second, first]);
      });
      expect(view.result.current.revision).toBeGreaterThan(submitted.revision);
      act(() => submitted.updateIfUnchanged(submitted.revision, { text: "", referenceTokens: [] }));
      expect(view.result.current.text).toBe(change === "text edit" ? "newer" : "original");
      expect(view.result.current.referenceTokens).toEqual(change === "token identity"
        ? [replacement, second] : change === "token order" ? [second, first] : [first, second]);
    },
  );

});
