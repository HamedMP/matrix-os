// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChatNavigationStore, useBotConversationSummaries, type ChatAgentClient } from "@matrix-os/ui";
import { useAgentRailLibrary } from "../../packages/ui/src/chat-agents/bots/use-agent-rail-library";
import type { CanonicalChatDetailResponse, CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { CanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof createChatNavigationStore>, client: null as unknown as CanonicalShellChatClient }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
vi.mock("../../shell/src/lib/canonical-chat-client", async original => ({
  ...await original<typeof import("../../shell/src/lib/canonical-chat-client")>(), createCanonicalShellChatClient: () => state.client,
}));
vi.mock("../../shell/src/hooks/useChatNavigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useShellChatNavigation: () => ({ ...useSyncExternalStore(state.store.subscribe, state.store.getSnapshot), store: state.store }) };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function detail(title = "Old transcript"): CanonicalChatDetailResponse {
  return { record: { chat: { id: "chat_same", title, titleVersion: 0, revision: 0, messageCount: 1,
    ownerScope: { type: "personal", ownerId: "owner_test" }, lifecycle: "active", attention: "none",
    currentSelection: { instanceId: "pi_default", model: "model" }, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
  } }, messages: [{ id: "msg_same", chatId: "chat_same", seq: 1, role: "assistant", state: "committed", parts: [{ type: "text", text: title }], createdAt: "2026-10-08T00:00:00Z" }], turns: [], runs: [], activities: [] };
}
function snapshot(): CanonicalChatNavigationResponse {
  const { ownerScope: _owner, currentSelection: _selection, ...chat } = detail().record.chat;
  return { version: 1, truncated: false, items: [{ chat, readState: { unread: false, markedUnread: false, version: 0, latestIncomingSeq: 0, readThroughSeq: 0 }, classification: { kind: "ordinary" }, persistence: "personal" }] };
}
beforeEach(async () => {
  state.store = createChatNavigationStore({ load: async () => snapshot() });
  await state.store.refresh();
  state.client = { detail: vi.fn(async () => detail()), updateTitle: vi.fn(async () => detail("Old rename").record), updateReadState: vi.fn(async () => detail().record),
    create: vi.fn(async () => detail().record), admitTurn: vi.fn(),
    openEventStream: vi.fn(async () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })),
    agents: { list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_one", name: "Private Bot", recipeRef: {} }] })), bots: {
      directChat: vi.fn(async () => "chat_bot"), directBot: vi.fn(async () => null), tasks: vi.fn(async () => []),
      interactions: vi.fn(async () => [{ kind: "approval", status: "pending", expiresAt: "2099-01-01T00:00:00Z" }]),
    } } as unknown as ChatAgentClient,
  } as CanonicalShellChatClient;
});
afterEach(() => { cleanup(); state.store.dispose(); vi.restoreAllMocks(); });
const mount = () => renderHook(() => useCanonicalChatState({ navigationScope: "owner/runtime/main", navigationGeneration: "same_session" }));
const options = { instanceId: "pi_default", model: "model", interactionMode: "default" as const, permissionMode: "supervised" as const };
it("clears Bot names/approvals and library across same-store revoke/recovery without rotating normal action identity", async () => {
  const hook = renderHook(() => {
    const chat = useCanonicalChatState();
    const summaries = useBotConversationSummaries(chat.agentSummaryClient ?? chat.agentClient, [], true);
    const library = useAgentRailLibrary(chat.agentSummaryClient ?? chat.agentClient, true, undefined);
    return { chat, summaries, library };
  });
  await waitFor(() => expect(hook.result.current.summaries.conversations[0]?.pendingApprovalCount).toBe(1));
  const first = hook.result.current.chat.agentSummaryClient;
  expect(hook.result.current.chat.agentClient).toBe(state.client.agents);
  await act(async () => hook.result.current.chat.switchConversation("chat_other"));
  expect(hook.result.current.chat.agentSummaryClient).toBe(first);
  act(() => state.store.revoke());
  expect(hook.result.current.chat.agentClient).toBeUndefined();
  expect(hook.result.current.chat.agentSummaryClient).toBeUndefined();
  expect(hook.result.current.summaries.conversations).toEqual([]);
  expect((hook.result.current.library?.agents ?? [])).toEqual([]);
  vi.mocked(state.client.agents!.list).mockImplementation(() => new Promise(() => {}));
  await act(async () => state.store.refresh());
  expect(hook.result.current.chat.agentClient).toBe(state.client.agents);
  expect(hook.result.current.chat.agentSummaryClient).not.toBe(first);
  expect(hook.result.current.summaries.conversations).toEqual([]);
  expect((hook.result.current.library?.agents ?? [])).toEqual([]);
});
it("hides loaded detail immediately on revoke, and never restores it during pending recovery", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.messages[0]?.content).toBe("Old transcript"));
  act(() => state.store.revoke());
  expect(hook.result.current.messages.filter(message => message.role !== "system")).toEqual([]);
  expect(hook.result.current.providerSelection).toBeUndefined();
  expect(hook.result.current.displayedThroughSeq).toBe(0);
  vi.mocked(state.client.detail).mockImplementation(() => new Promise(() => {}));
  await act(async () => state.store.refresh());
  expect(hook.result.current.messages).toEqual([]);
});
it("fences a pending detail even when revoke/recovery finishes before React cleanup", async () => {
  const pending = deferred<CanonicalChatDetailResponse>();
  vi.mocked(state.client.detail).mockImplementationOnce(() => pending.promise).mockImplementation(() => new Promise(() => {}));
  const hook = mount();
  await waitFor(() => expect(state.client.detail).toHaveBeenCalled());
  await act(async () => { state.store.revoke(); await state.store.refresh(); pending.resolve(detail("Late private detail")); });
  expect(hook.result.current.messages).toEqual([]);
});
it.each(["rename", "read"])("fences pending %s mutation and stale retained actions across same-store recovery", async operation => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.messages[0]?.content).toBe("Old transcript"));
  const pending = deferred<ReturnType<typeof detail>["record"]>();
  const method = operation === "rename" ? state.client.updateTitle : state.client.updateReadState;
  vi.mocked(method).mockImplementationOnce(() => pending.promise);
  const captured = hook.result.current;
  let result!: Promise<boolean>;
  act(() => { result = operation === "rename" ? captured.renameConversation!("chat_same", "Old rename") : captured.updateReadState!("chat_same", { type: "mark_unread" }); });
  vi.mocked(state.client.detail).mockResolvedValue(detail("Recovered transcript"));
  await act(async () => { state.store.revoke(); await state.store.refresh(); });
  await waitFor(() => expect(hook.result.current.messages[0]?.content).toBe("Recovered transcript"));
  await act(async () => { pending.resolve(detail("Old rename").record); expect(await result).toBe(false); });
  expect(hook.result.current.messages[0]?.content).toBe("Recovered transcript");
  expect(hook.result.current.activeConversationTitle).not.toBe("Old rename");
  const calls = vi.mocked(method).mock.calls.length;
  await act(async () => { await captured.renameConversation!("chat_same", "stale"); captured.switchConversation("chat_old"); });
  expect(vi.mocked(method).mock.calls.length).toBe(calls);
  expect(hook.result.current.sessionId).toBe("chat_same");
});
it("stops a pending create before admission after revocation and releases submitting state", async () => {
  const hook = mount();
  await act(async () => hook.result.current.newChat());
  const pending = deferred<ReturnType<typeof detail>["record"]>();
  vi.mocked(state.client.create).mockImplementationOnce(() => pending.promise);
  let result!: Promise<boolean>;
  act(() => { result = hook.result.current.submitMessage("hello", undefined, options); });
  await act(async () => { state.store.revoke(); await state.store.refresh(); });
  await act(async () => { pending.resolve(detail().record); expect(await result).toBe(false); });
  expect(state.client.admitTurn).not.toHaveBeenCalled();
  await waitFor(() => expect(hook.result.current.busy).toBe(false));
});

it("retains local unsent Chat and Bot text through same-owner epoch/token recovery, but clears it on owner replacement", async () => {
  const hook = renderHook(({ scope, generation }) => {
    const chat = useCanonicalChatState({ navigationScope: scope, navigationGeneration: generation });
    return { chat, draft: useChatComposerDraft("chat_same", chat.composerIdentity) };
  }, { initialProps: { scope: "owner/runtime/main", generation: "session_1" } });
  act(() => { hook.result.current.draft.setText("Unsent local draft"); hook.result.current.chat.requestComposerDraft!("Pending local intent"); });
  const identity = hook.result.current.chat.composerIdentity;
  act(() => state.store.revoke());
  expect(hook.result.current.draft.text).toBe("Unsent local draft");
  await act(async () => state.store.refresh());
  await act(async () => hook.rerender({ scope: "owner/runtime/main", generation: "session_2" }));
  expect(hook.result.current.chat.composerIdentity).toBe(identity);
  expect(hook.result.current.chat.composerDraftRequest?.text).toBe("Pending local intent");
  expect(hook.result.current.draft.text).toBe("Unsent local draft");
  await act(async () => hook.rerender({ scope: "another/runtime/main", generation: "session_3" }));
  expect(hook.result.current.draft.text).toBe("");
  expect(hook.result.current.chat.composerDraftRequest).toBeNull();
});
it("does not revoke retained Agent summaries on a transient navigation refresh failure", async () => {
  let fail = false;
  state.store.dispose();
  state.store = createChatNavigationStore({ load: async () => { if (fail) throw new Error("Unavailable"); return snapshot(); } });
  await state.store.refresh();
  const hook = mount();
  const client = hook.result.current.agentSummaryClient;
  fail = true;
  await act(async () => state.store.refresh());
  expect(hook.result.current.agentClient).toBe(state.client.agents);
  expect(hook.result.current.agentSummaryClient).toBe(client);
});
it("rejects a late summary library result before it can populate the old cache after revoke", async () => {
  const pending = deferred<Awaited<ReturnType<ChatAgentClient["list"]>>>();
  vi.mocked(state.client.agents!.list).mockImplementationOnce(() => pending.promise);
  const hook = mount();
  const prior = hook.result.current.agentSummaryClient!;
  const result = prior.list().catch(error => error);
  await act(async () => {
    state.store.revoke(); await state.store.refresh();
    pending.resolve({ enabled: true, agents: [] });
    expect(await result).toBeInstanceOf(Error);
  });
  await expect(prior.list()).rejects.toThrow("ChatAuthorityChanged");
  expect(state.client.agents!.list).toHaveBeenCalledTimes(1);
});

it.each(["approval", "input", "queue", "cancel"])("does not publish a late %s failure or reload recovered detail", async operation => {
  const running = detail();
  running.record.activeRun = { runId: "run_same", turnId: "cturn_same", status: "running" };
  vi.mocked(state.client.detail).mockResolvedValue(running);
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  state.client.submitApproval = vi.fn(() => pending);
  state.client.submitInput = vi.fn(() => pending);
  state.client.cancelQueuedTurn = vi.fn(() => pending);
  state.client.cancelRun = vi.fn(() => pending);
  const hook = mount();
  await waitFor(() => expect(hook.result.current.activeRunId).toBe("run_same"));
  const previous = hook.result.current;
  let result: Promise<boolean> | undefined;
  act(() => {
    if (operation === "approval") result = previous.submitApproval!("run_same", "approval_same", "approve");
    else if (operation === "input") result = previous.submitInput!("run_same", "input_same", { answer: "yes" });
    else if (operation === "queue") result = previous.cancelQueuedTurn!("queued_same");
    else previous.abortCurrent();
  });
  vi.mocked(state.client.detail).mockResolvedValue(detail("Recovered transcript"));
  await act(async () => { state.store.revoke(); await state.store.refresh(); });
  await waitFor(() => expect(hook.result.current.messages[0]?.content).toBe("Recovered transcript"));
  const detailCalls = vi.mocked(state.client.detail).mock.calls.length;
  await act(async () => { reject(new Error("late rejection")); if (result) expect(await result).toBe(false); });
  expect(state.client.detail).toHaveBeenCalledTimes(detailCalls);
  expect(hook.result.current.messages).toHaveLength(1);
});
