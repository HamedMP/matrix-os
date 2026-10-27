// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["transport", "http408"])("confirms a committed Web turn after %s timeout using one POST and the exact durable receipt", async mode => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const record = { chat, projectId: project?.id, providerBinding, activeRun };
  let fresh = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  let posts = 0;
  const accepted = vi.fn();
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    if (url.includes(`/api/chats/${chat.id}?`)) return Response.json(fresh);
    if (url.includes(`/api/chats/${chat.id}/turns?`)) {
      posts++;
      const request = JSON.parse(String(init?.body));
      const turn = { ...snapshot.turns[0]!, id: "cturn_web_receipt", clientRequestId: request.clientRequestId, inputMessageId: "msg_web_receipt" };
      const message = { ...snapshot.messages[0]!, id: turn.inputMessageId, turnId: turn.id, parts: request.parts, seq: chat.messageCount + 1 };
      const run = { ...snapshot.runs[0]!, id: "run_web_receipt", turnId: turn.id };
      fresh = { ...fresh, record: { ...record, chat: { ...chat, revision: chat.revision + 2 } },
        turns: [...snapshot.turns, turn], messages: [...snapshot.messages, message], runs: [...snapshot.runs, run] };
      if (mode === "transport") throw new DOMException("deadline", "TimeoutError");
      return Response.json({ error: "Timeout" }, { status: 408 });
    }
    throw new Error(`Unexpected ${url}`);
  });
  stubLegacyChatFetch(fetchFn);
  const hook = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(hook.result.current.sessionId).toBe(chat.id));
  let result: unknown;
  await act(async () => { result = await hook.result.current.submitMessage("continue once", undefined, {
    instanceId: "codex_default", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised",
    onAccepted: accepted,
  }); });
  expect(result).toBe(true);
  expect(posts).toBe(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(hook.result.current.messages.at(-1)?.content).toBe("continue once");
});

it("preserves a newer Web rejection when an older timed-out send is confirmed by refresh", async () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const record = { chat, projectId: project?.id, providerBinding, activeRun };
  let fresh = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  let original: { clientRequestId: string; parts: typeof snapshot.messages[0]["parts"] } | undefined;
  let posts = 0;
  const accepted = vi.fn();
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    if (url.includes(`/api/chats/${chat.id}?`)) return Response.json(fresh);
    if (url.includes(`/api/chats/${chat.id}/turns?`)) {
      posts++;
      if (posts === 1) { original = JSON.parse(String(init?.body)); throw new DOMException("deadline", "TimeoutError"); }
      return Response.json({ error: { code: "authorization_failed" } }, { status: 403 });
    }
    throw new Error(`Unexpected ${url}`);
  });
  stubLegacyChatFetch(fetchFn);
  const hook = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(hook.result.current.sessionId).toBe(chat.id));
  const options = { instanceId: "codex_default", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised" };
  await act(async () => { await hook.result.current.submitMessage("original", undefined, { ...options, onAccepted: accepted }); });
  await act(async () => { await hook.result.current.submitMessage("new draft", undefined, options); });
  expect(hook.result.current.messages.at(-1)?.content).toBe("You do not have permission to send this message.");
  const turn = { ...snapshot.turns[0]!, id: "cturn_old_web", clientRequestId: original!.clientRequestId, inputMessageId: "msg_old_web" };
  fresh = { ...fresh, record: { ...record, chat: { ...chat, revision: chat.revision + 2 } },
    turns: [...snapshot.turns, turn], messages: [...snapshot.messages, { ...snapshot.messages[0]!, id: turn.inputMessageId, turnId: turn.id, parts: original!.parts, seq: chat.messageCount + 1 }],
    runs: [...snapshot.runs, { ...snapshot.runs[0]!, id: "run_old_web", turnId: turn.id }] };
  act(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
  expect(hook.result.current.messages.at(-1)?.content).toBe("You do not have permission to send this message.");
  expect(posts).toBe(2);
});

it("releases one hundred passively confirmed resource sends while retaining an unknown retry identity", async () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const record = { chat, projectId: project?.id, providerBinding, activeRun };
  let fresh = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities };
  const requests: Array<{ clientRequestId: string; parts: typeof snapshot.messages[0]["parts"] }> = [];
  const accepted = vi.fn();
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/chats?")) return Response.json({ items: [fresh.record] });
    if (url.includes(`/api/chats/${chat.id}?`)) return Response.json(fresh);
    if (url.includes(`/api/chats/${chat.id}/turns?`)) {
      requests.push(JSON.parse(String(init?.body)));
      throw new DOMException("deadline", "TimeoutError");
    }
    throw new Error(`Unexpected ${url}`);
  });
  stubLegacyChatFetch(fetchFn);
  const hook = renderHook(() => useCanonicalChatState());
  await waitFor(() => expect(hook.result.current.sessionId).toBe(chat.id));
  const options = { instanceId: "codex_default", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised",
    resources: [{ kind: "file" as const, id: "file_readme", label: "readme", path: "README.md" }], onAccepted: accepted };
  try {
    for (let index = 0; index < 100; index++) {
      let result: unknown;
      await act(async () => { result = await hook.result.current.submitMessage(`resource message ${index}`, undefined,
        { ...options, clientRequestId: `req_passive_${index}` }); });
      expect(result).toBe(false);
      expect(requests).toHaveLength(index + 1);
      const request = requests[index]!;
      const turn = { ...snapshot.turns[0]!, id: `cturn_passive_${index}`, clientRequestId: request.clientRequestId,
        inputMessageId: `msg_passive_${index}`, baseMessageSeq: fresh.record.chat.messageCount };
      fresh = { ...fresh, record: { ...fresh.record, chat: { ...fresh.record.chat,
        revision: fresh.record.chat.revision + 2, messageCount: fresh.record.chat.messageCount + 1 } },
        turns: [...snapshot.turns, turn], messages: [...snapshot.messages, { ...snapshot.messages[0]!, id: turn.inputMessageId,
          turnId: turn.id, parts: request.parts, seq: fresh.record.chat.messageCount + 1 }],
        runs: [...snapshot.runs, { ...snapshot.runs[0]!, id: `run_passive_${index}`, turnId: turn.id }] };
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(accepted).toHaveBeenCalledTimes(index + 1);
    }
    // The next unresolved send can still be posted, and a manual retry retains its exact id/body.
    await act(async () => { await hook.result.current.submitMessage("still unknown", undefined,
      { ...options, clientRequestId: "req_still_unknown" }); });
    expect(requests).toHaveLength(101);
    await act(async () => { await hook.result.current.submitMessage("still unknown", undefined,
      { ...options, clientRequestId: "req_still_unknown" }); });
    expect(requests).toHaveLength(102);
    expect(requests[101]).toEqual(requests[100]);
    expect(accepted).toHaveBeenCalledTimes(100);
  } finally { hook.unmount(); }
}, 15_000);
