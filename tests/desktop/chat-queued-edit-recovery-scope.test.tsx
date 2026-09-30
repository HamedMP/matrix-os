// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, snapshot } from "./canonical-chat-workspace-test-utils";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { AppError } from "@desktop/shared/app-error";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(["edit", "queue"].flatMap((mode) => ["before_rejection", "during_refresh"].map((timing) => ({ mode, timing }))))("keeps an internal Chat switch isolated from $mode recovery ($timing)", async ({ mode, timing }) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const client = createCanonicalChatWorkspaceClient();
  const second = { record: { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, id: "chat_second" } }, messages: [], turns: [], runs: [], activities: [] };
  const first = { record: { ...canonicalChatRecord, activeRun: createCanonicalChatFixture("running").snapshot.chat.activeRun }, messages: snapshot.messages, turns: snapshot.turns, runs: [], activities: [] };
  let finishRefresh!: (value: typeof first) => void;
  let deferRefresh = false;
  vi.mocked(client.getDetail).mockImplementation(async (id) => {
    if (id === "chat_second") return second;
    if (deferRefresh) return new Promise((resolve) => { finishRefresh = resolve; });
    return first;
  });
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, no) => { reject = no; });
  vi.mocked(client.updateQueuedTurn).mockReturnValue(pending);
  vi.mocked(client.queueTurn).mockReturnValue(pending);
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: canonicalChatRecord.chat.id, autoSelectFirst: false }));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe(canonicalChatRecord.chat.id));
  const onAccepted = vi.fn();
  let request!: Promise<unknown>;
  act(() => { request = mode === "edit" ? hook.result.current.updateQueuedTurn("queued_test", [{ type: "text", text: "edited" }], onAccepted) : hook.result.current.queueTurn({ parts: [{ type: "text", text: "edited" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised" }, onAccepted); });
  const calls = vi.mocked(client.getDetail).mock.calls.length;
  if (timing === "during_refresh") {
    deferRefresh = true;
    await act(async () => reject(new AppError("offline")));
    await waitFor(() => expect(client.getDetail).toHaveBeenCalledTimes(calls + 1));
  }
  act(() => hook.result.current.selectChat("chat_second"));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe("chat_second"));
  if (timing === "before_rejection") await act(async () => { reject(new AppError("offline")); await request; });
  else await act(async () => { finishRefresh(first); await request; });
  expect(hook.result.current.activeChatId).toBe("chat_second");
  expect(hook.result.current.detail?.record.chat.id).toBe("chat_second");
  expect(hook.result.current.error).toBeNull();
  expect(onAccepted).not.toHaveBeenCalled();
  if (timing === "before_rejection") expect(vi.mocked(client.getDetail).mock.calls.filter(([id]) => id === canonicalChatRecord.chat.id)).toHaveLength(calls);
});

it.each(["send", "queue", "edit"] as const)("does not publish late successful %s admission after an internal Chat switch", async (mode) => {
  const client = createCanonicalChatWorkspaceClient();
  const first = { record: { ...canonicalChatRecord, activeRun: createCanonicalChatFixture("running").snapshot.chat.activeRun }, messages: snapshot.messages, turns: snapshot.turns, runs: [], activities: [] };
  const second = { record: { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, id: "chat_second" } }, messages: [], turns: [], runs: [], activities: [] };
  vi.mocked(client.getDetail).mockImplementation(async (id) => id === "chat_second" ? second : first);
  let finish!: (value: never) => void;
  const pending = new Promise<never>((resolve) => { finish = resolve; });
  vi.mocked(client.admitTurn).mockReturnValue(pending);
  vi.mocked(client.queueTurn).mockReturnValue(pending);
  vi.mocked(client.updateQueuedTurn).mockReturnValue(pending);
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: canonicalChatRecord.chat.id, autoSelectFirst: false }));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe(canonicalChatRecord.chat.id));
  const input = { parts: [{ type: "text" as const, text: "submitted" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised" };
  const onAccepted = vi.fn();
  let request!: Promise<unknown>;
  act(() => { request = mode === "send" ? hook.result.current.submitTurn(input, "Title", null, onAccepted) : mode === "queue" ? hook.result.current.queueTurn(input, onAccepted) : hook.result.current.updateQueuedTurn("queued_test", input.parts, onAccepted); });
  act(() => hook.result.current.selectChat("chat_second"));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe("chat_second"));
  const response = mode === "send" ? { record: first.record, message: snapshot.messages[0], turn: snapshot.turns[0], run: snapshot.runs[0], admission: "accepted" }
    : { queuedTurn: { id: "queued_test", updatedAt: "2026-09-01T00:00:00.000Z" }, queueDepth: 1 };
  await act(async () => { finish(response as never); await request; });
  expect(hook.result.current.activeChatId).toBe("chat_second");
  expect(hook.result.current.detail?.record.chat.id).toBe("chat_second");
  expect(await request).toBeNull();
  expect(onAccepted).toHaveBeenCalledOnce();
});

it("does not acknowledge an already-claimed queue after its success refresh crosses Chat scope", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const first = { record: { ...canonicalChatRecord, activeRun: createCanonicalChatFixture("running").snapshot.chat.activeRun }, messages: snapshot.messages, turns: snapshot.turns, runs: [], activities: [] };
  const second = { record: { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, id: "chat_second" } }, messages: [], turns: [], runs: [], activities: [] };
  let finishRefresh!: (value: typeof first) => void;
  let refreshing = false;
  vi.mocked(client.getDetail).mockImplementation(async (id) => {
    if (id === "chat_second") return second;
    if (refreshing) return new Promise((resolve) => { finishRefresh = resolve; });
    return first;
  });
  vi.mocked(client.queueTurn).mockResolvedValue({ alreadyClaimed: true, queueDepth: 0 } as never);
  const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: null, active: true, initialChatId: canonicalChatRecord.chat.id, autoSelectFirst: false }));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe(canonicalChatRecord.chat.id));
  refreshing = true;
  const onAccepted = vi.fn();
  let request!: Promise<unknown>;
  act(() => { request = hook.result.current.queueTurn({ parts: [{ type: "text", text: "submitted" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised" }, onAccepted); });
  await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
  act(() => hook.result.current.selectChat("chat_second"));
  await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe("chat_second"));
  await act(async () => { finishRefresh(first); await request; });
  expect(await request).toBeNull();
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(hook.result.current.detail?.record.chat.id).toBe("chat_second");
});
