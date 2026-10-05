// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "@/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
const running = createCanonicalChatFixture("running").snapshot;
const aborted = createCanonicalChatFixture("aborted").snapshot.runs[0]!;
const chatId = running.chat.id;
const runId = running.chat.activeRun!.runId;
function detail(active = true) {
  const { activeRun, providerBinding, project, ...chat } = running.chat;
  return { record: { chat, ...(active ? { activeRun } : {}) },
    messages: running.messages, turns: [], runs: [], activities: [] };
}
function harness({ fail = false }: { fail?: boolean } = {}) {
  const getDetail = vi.fn(async () => Response.json(detail()));
  const cancel = vi.fn(async (_init?: RequestInit) => {
    if (fail) return Response.json({ error: { code: "upstream_private_error" } }, { status: 503 });
    getDetail.mockImplementation(async () => Response.json(detail(false)));
    return Response.json({ run: { ...aborted, id: runId, chatId }, cancellation: "aborted" });
  });
  let resolveNext!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/chats/events?")) return new Response(new ReadableStream(), {
      headers: { "content-type": "text/event-stream" },
    });
    if (url.includes("/api/chats?")) return Response.json({ items: [detail().record] });
    if (url.includes(`/api/chats/${chatId}?`)) return getDetail();
    if (url.includes(`/api/chats/${chatId}/runs/${runId}/cancel`)) return cancel(init);
    if (url.includes("/api/chats/chat_next?")) return new Promise<Response>(resolve => { resolveNext = resolve; });
    throw new Error("Unexpected request");
  }));
  return { getDetail, cancel, resolveNext: () => resolveNext(Response.json({ ...detail(false),
    record: { chat: { ...detail(false).record.chat, id: "chat_next" } }, messages: [] })) };
}
beforeEach(() => { window.history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("selected canonical Chat run cancellation", () => {
  it("exposes the active run and cancels that exact run once, then reloads eligibility", async () => {
    const h = harness();
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.sessionId).toBe(chatId));
    await waitFor(() => expect(result.current.activeRunId).toBe(runId));
    act(() => result.current.abortCurrent());
    await waitFor(() => expect(result.current.activeRunId).toBeUndefined());
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.cancel.mock.calls[0]?.[0]).toMatchObject({ method: "POST" });
    expect(h.getDetail).toHaveBeenCalledTimes(2);
    expect(result.current.busy).toBe(false);
  });
  it("retains Stop eligibility and exposes only a safe message if cancellation fails", async () => {
    const h = harness({ fail: true });
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.activeRunId).toBe(runId));
    act(() => result.current.abortCurrent());
    await waitFor(() => expect(result.current.messages.some(message => message.content === "The run could not be stopped. Try again.")).toBe(true));
    expect(result.current.activeRunId).toBe(runId);
    expect(result.current.busy).toBe(true);
    expect(h.cancel).toHaveBeenCalledOnce();
  });
  it.each(["success", "failure"])("keeps the new Chat unchanged when an earlier cancellation settles with %s", async (outcome) => {
    const h = harness();
    let resolveCancel!: (response: Response) => void;
    let rejectCancel!: (error: Error) => void;
    h.cancel.mockImplementationOnce(() => new Promise<Response>((resolve, reject) => {
      resolveCancel = resolve;
      rejectCancel = reject;
    }));
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.activeRunId).toBe(runId));
    act(() => result.current.abortCurrent());
    await waitFor(() => expect(h.cancel).toHaveBeenCalledOnce());
    act(() => result.current.switchConversation("chat_next"));
    await act(async () => { h.resolveNext(); });
    expect(result.current.busy).toBe(false);
    const nextMessages = result.current.messages;
    await act(async () => {
      if (outcome === "failure") rejectCancel(new Error("Private upstream failure"));
      else resolveCancel(Response.json({ run: { ...aborted, id: runId, chatId }, cancellation: "aborted" }));
    });
    expect(result.current.sessionId).toBe("chat_next");
    expect(result.current.activeRunId).toBeUndefined();
    expect(result.current.messages).toEqual(nextMessages);
    expect(result.current.messages).toEqual([]);
    expect(h.getDetail).toHaveBeenCalledOnce();
  });
  it("does not expose or cancel the previous chat's run while the next chat loads", async () => {
    const h = harness();
    const { result } = renderHook(() => useCanonicalChatState());
    await waitFor(() => expect(result.current.activeRunId).toBe(runId));
    const staleAbort = result.current.abortCurrent;
    act(() => {
      result.current.switchConversation("chat_next");
      staleAbort();
    });
    expect(result.current.sessionId).toBe("chat_next");
    expect(result.current.busy).toBe(true);
    expect(result.current.activeRunId).toBeUndefined();
    act(() => staleAbort());
    expect(h.cancel).not.toHaveBeenCalled();
    await act(async () => { h.resolveNext(); });
    expect(result.current.activeRunId).toBeUndefined();
  });
});
