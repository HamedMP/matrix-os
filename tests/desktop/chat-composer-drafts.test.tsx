// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_COMPOSER_DRAFTS, useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { desktopProviderIdentityKey } from "@desktop/renderer/src/lib/provider-settings-identity";
import { useChatComposerDrafts } from "@desktop/renderer/src/features/chat/use-chat-composer-drafts";

describe("Chat-bound composer drafts", () => {
  it("keeps an explicitly removed Project detached through edits and navigation", () => {
    const view = renderHook(({ projectId }) => useChatComposerDrafts({ clientIdentity: "client", chatId: null, projectId, conversation: false }), { initialProps: { projectId: "matrix-os" as string | null } });
    act(() => { view.result.current.setText("keep this draft"); view.result.current.setDraftProjectId(null); });
    expect(view.result.current.draftProjectId).toBeNull();
    act(() => view.result.current.setText("keep this draft edited"));
    view.rerender({ projectId: null });
    view.rerender({ projectId: "matrix-os" });
    expect(view.result.current.draftProjectId).toBeNull();
    expect(view.result.current.text).toBe("keep this draft edited");
    act(() => view.result.current.prepareNewChatDraft());
    expect(view.result.current.draftProjectId).toBe("matrix-os");
  });
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

describe("Retained owner/runtime composer drafts", () => {
  beforeEach(() => useConnection.setState({ status: "signed-in", handle: "draft-owner", userId: "owner_a", runtimeSlot: "preview", authGeneration: useConnection.getState().authGeneration + 1 }));
  const identity = () => `${desktopProviderIdentityKey(useConnection.getState())}|${useConnection.getState().userId ?? "none"}`;
  it("retains Bot text/references and detached Project context across client and workspace remounts", () => {
    const retentionIdentity = identity();
    const bot = renderHook(() => useChatComposerDrafts({ clientIdentity: "mount-client", retentionIdentity, chatId: "bot_chat", projectId: null, conversation: true }));
    const tokens = [{ type: "resource" as const, resource: { kind: "file" as const, id: "notes", label: "notes.md" } }];
    act(() => { bot.result.current.setText("Unsent Bot draft"); bot.result.current.setReferenceTokens(tokens); });
    const revision = bot.result.current.revision;
    bot.unmount();
    const project = renderHook(() => useChatComposerDrafts({ clientIdentity: "mount-client", retentionIdentity, chatId: null, projectId: "project_a", conversation: false }));
    act(() => { project.result.current.setText("Project plan"); project.result.current.setDraftProjectId(null); });
    project.unmount();
    const reopened = renderHook(() => useChatComposerDrafts({ clientIdentity: "reopened-client", retentionIdentity, chatId: "bot_chat", projectId: null, conversation: true }));
    expect(reopened.result.current.text).toBe("Unsent Bot draft");
    expect(reopened.result.current.referenceTokens).toEqual(tokens);
    expect(reopened.result.current.revision).toBe(revision);
    expect(reopened.result.current.seedChatDraft("bot_chat", "Incoming mention")).toBe(false);
    reopened.unmount();
    const reopenedProject = renderHook(() => useChatComposerDrafts({ clientIdentity: "mount-client", retentionIdentity, chatId: null, projectId: "project_a", conversation: false }));
    expect(reopenedProject.result.current.text).toBe("Project plan");
    expect(reopenedProject.result.current.draftProjectId).toBeNull();
  });
  it.each(["account", "runtime", "auth"])("fences reads and retained callbacks on %s replacement", changed => {
    const retentionIdentity = identity();
    const old = renderHook(() => useChatComposerDrafts({ clientIdentity: "mount-client", retentionIdentity, chatId: "same_chat", projectId: null, conversation: true }));
    act(() => old.result.current.setText("Private owner A"));
    const staleWrite = old.result.current.setText;
    act(() => useConnection.setState(changed === "account" ? { userId: "owner_b" } : changed === "runtime" ? { runtimeSlot: "another-preview" } : { authGeneration: useConnection.getState().authGeneration + 1 }));
    expect(old.result.current.text).toBe("");
    const next = renderHook(() => useChatComposerDrafts({ clientIdentity: "mount-client", retentionIdentity: identity(), chatId: "same_chat", projectId: null, conversation: true }));
    expect(next.result.current.text).toBe("");
    act(() => staleWrite("Late private callback"));
    expect(next.result.current.text).toBe("");
  });
  it("does not let a pre-unmount admission acknowledgement overwrite reopened edits", () => {
    const retentionIdentity = identity();
    const old = renderHook(() => useChatComposerDrafts({ clientIdentity: "first", retentionIdentity, chatId: "bot_chat", projectId: null, conversation: true }));
    act(() => old.result.current.setText("Submitted draft"));
    const revision = old.result.current.revision;
    const acknowledge = old.result.current.updateIfUnchanged;
    const seed = old.result.current.seedChatDraft;
    old.unmount();
    const reopened = renderHook(() => useChatComposerDrafts({ clientIdentity: "second", retentionIdentity, chatId: "bot_chat", projectId: null, conversation: true }));
    act(() => reopened.result.current.setText("Typed after navigation"));
    act(() => acknowledge(revision, {text:"",referenceTokens:[]}));
    expect(reopened.result.current.text).toBe("Typed after navigation");
    expect(seed("bot_chat", "Late incoming mention")).toBe(false);
  });
  it("evicts the oldest draft after the bounded retention cache is full", () => {
    const retentionIdentity = identity();
    const view = renderHook(({chatId}) => useChatComposerDrafts({ clientIdentity:"cache-client", retentionIdentity, chatId, projectId:null, conversation:true }), {initialProps:{chatId:"chat_0"}});
    for (let index=0; index<=MAX_COMPOSER_DRAFTS; index++) {
      view.rerender({chatId:`chat_${index}`});
      act(() => view.result.current.setText(`Draft ${index}`));
    }
    expect(Object.keys(useRetainedComposerDrafts.getState().drafts)).toHaveLength(MAX_COMPOSER_DRAFTS);
    view.rerender({chatId:"chat_0"}); expect(view.result.current.text).toBe("");
    view.rerender({chatId:`chat_${MAX_COMPOSER_DRAFTS}`}); expect(view.result.current.text).toBe(`Draft ${MAX_COMPOSER_DRAFTS}`);
  });

  it("does not acknowledge an evicted and recreated draft with an old revision", () => {
    const retentionIdentity = identity();
    const view = renderHook(({chatId}) => useChatComposerDrafts({clientIdentity:"aba-client",retentionIdentity,chatId,projectId:null,conversation:true}),{initialProps:{chatId:"recreated"}});
    act(() => view.result.current.setText("Old request"));
    const oldRevision=view.result.current.revision; const acknowledge=view.result.current.updateIfUnchanged;
    for(let index=0;index<MAX_COMPOSER_DRAFTS;index++) {
      view.rerender({chatId:`evict_${index}`}); act(() => view.result.current.setText(`Draft ${index}`));
    }
    view.rerender({chatId:"recreated"}); act(() => view.result.current.setText("New request"));
    expect(view.result.current.revision).toBeGreaterThan(oldRevision);
    act(() => acknowledge(oldRevision,{text:"",referenceTokens:[]}));
    expect(view.result.current.text).toBe("New request");
  });

});
