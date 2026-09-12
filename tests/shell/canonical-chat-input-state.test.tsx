// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("retries answers with the same identity while preserving the normal composer draft", async () => {
  const chat = { id: "chat_input", ownerScope: { type: "personal", ownerId: "owner_input" }, title: "Input", lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" };
  const record = { chat, activeRun: { runId: "run_input", turnId: "cturn_input", status: "waiting_for_input" } };
  const requests: RequestInit[] = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (url.includes("/inputs/")) {
      requests.push(init!);
      if (requests.length === 1) throw new Error("private network details");
      return Response.json({ requestId: "input_question", submission: "accepted" });
    }
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    return Response.json({ record, messages: [], runs: [], turns: [], activities: [] });
  }));
  const { result, unmount } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.sessionId).toBe(chat.id));
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => result.current.requestComposerDraft("Unsent draft"));
  await act(async () => { expect(await result.current.submitInput!("run_input", "input_question", { structuredAnswers: { direction: ["North"] } })).toBe(false); });
  expect(result.current.composerDraftRequest?.text).toBe("Unsent draft");
  await act(async () => { expect(await result.current.submitInput!("run_input", "input_question", { structuredAnswers: { direction: ["South"] } })).toBe(true); });
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[0]!.body as string).clientRequestId).toBe(JSON.parse(requests[1]!.body as string).clientRequestId);
  expect(JSON.parse(requests[1]!.body as string).structuredAnswers.direction).toEqual(["South"]);
  await act(async () => { expect(await result.current.submitInput!("run_other", "input_question", { answer: "Wrong run" })).toBe(false); });
  expect(requests).toHaveLength(2);
  unmount();
});

it("does not reload the previous chat after a late input response", async () => {
  const makeRecord = (id: string) => ({ chat: { id, ownerScope: { type: "personal", ownerId: "owner_input" }, title: id, lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" }, activeRun: { runId: "run_input", turnId: "cturn_input", status: "waiting_for_input" } });
  const first = makeRecord("chat_first"), second = makeRecord("chat_second");
  let finish!: (response: Response) => void;
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/events")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (url.includes("/inputs/")) return new Promise<Response>(resolve => { finish = resolve; });
    if (url.includes("/api/chats?")) return Response.json({ items: [first, second] });
    reads.push(url);
    return Response.json({ record: url.includes("chat_second") ? second : first, messages: [], runs: [], turns: [], activities: [] });
  }));
  const { result, unmount } = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(result.current.activeConversationTitle).toBe("chat_first"));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.submitInput!("run_input", "input_question", { answer: "North" }); });
  await waitFor(() => expect(finish).toBeDefined());
  act(() => result.current.switchConversation("chat_second"));
  await waitFor(() => expect(result.current.activeConversationTitle).toBe("chat_second"));
  const firstReads = reads.filter(url => url.includes("chat_first")).length;
  await act(async () => { finish(Response.json({ requestId: "input_question", submission: "accepted" })); await pending; });
  expect(reads.filter(url => url.includes("chat_first"))).toHaveLength(firstReads);
  expect(result.current.sessionId).toBe("chat_second");
  unmount();
});
