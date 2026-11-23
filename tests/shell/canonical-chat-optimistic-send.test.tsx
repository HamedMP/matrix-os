// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

// ENG-540: on a new Chat the sent message stayed invisible for 1.8-3.1 s while
// the Chat was created and its turn admitted, and every send re-read the list
// and the detail even though the event stream already carried the changes.

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { instanceId: "codex_fixture", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised" };

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

function attachedStream(): Response {
  const frames = [{ type: "chat.stream.attached" }, { type: "chat.replay.end" }];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function fixtureServer({ createGate, uploadGate, createFails, streamOpen = false }: {
  createGate?: Promise<void>; uploadGate?: Promise<void>; createFails?: boolean; streamOpen?: boolean;
} = {}) {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _activeRun, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
  const record = { chat };
  const existing = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [] };
  let admitted: typeof existing | null = null;
  const reads = { list: 0, detail: 0 };
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return streamOpen ? attachedStream() : new Response(new ReadableStream());
    if (url.includes("/api/files/blob?")) {
      await uploadGate;
      const path = new URL(url).searchParams.get("path")!;
      return Response.json({ ok: true, path, size: 5 });
    }
    if (url.includes("/api/chats?") && init?.method === "POST") {
      await createGate;
      if (createFails) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json({ chat: { ...chat, revision: 0, messageCount: 0 } });
    }
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const base = admitted ?? (url.includes(chat.id) ? existing : { ...existing, messages: [], turns: [], runs: [] });
      const message = { ...snapshot.messages[0]!, id: "msg_sent", seq: 99, role: "user" as const, state: "committed" as const, turnId: "cturn_sent", runId: undefined, parts: body.parts };
      const turn = { ...snapshot.turns[0]!, id: "cturn_sent", clientRequestId: body.clientRequestId, inputMessageId: "msg_sent", baseMessageSeq: 98 };
      const run = { ...snapshot.runs[0]!, id: "run_sent", turnId: "cturn_sent" };
      const next = { chat: { ...chat, revision: chat.revision + 1 } };
      admitted = { record: next, messages: [...base.messages, message], turns: [...base.turns, turn], runs: [...base.runs, run], activities: [] };
      return Response.json({ record: next, message, turn, run, admission: "accepted" });
    }
    if (url.includes("/api/chats?")) {
      reads.list += 1;
      return Response.json({ items: [record] });
    }
    reads.detail += 1;
    return Response.json(admitted ?? existing);
  }));
  return { chat, reads };
}

const shownCount = (messages: { role: string; content: unknown }[], text: string) =>
  messages.filter((message) => message.role === "user" && String(message.content).includes(text)).length;

it("shows a new Chat's first message before the Chat exists, and once after admission", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const create = gate();
  const { chat } = fixtureServer({ createGate: create.opened });
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "First words" }));
  const onAccepted = vi.fn();

  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("First words", undefined, { ...options, onAccepted }); });
  await waitFor(() => expect(shownCount(result.current.messages, "First words")).toBe(1));
  expect(result.current.sessionId).toBeUndefined();
  expect(onAccepted).not.toHaveBeenCalled();

  create.release();
  await act(async () => { expect(await sending).toBe(true); });
  expect(result.current.sessionId).toBe(chat.id);
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(shownCount(result.current.messages, "First words")).toBe(1);
});

it("keeps the composer draft and drops the bubble when the new Chat cannot be created", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const create = gate();
  fixtureServer({ createGate: create.opened, createFails: true });
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "Do not lose me" }));
  const onAccepted = vi.fn();

  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("Do not lose me", undefined, { ...options, onAccepted }); });
  await waitFor(() => expect(shownCount(result.current.messages, "Do not lose me")).toBe(1));

  create.release();
  await act(async () => { expect(await sending).toBe(false); });
  // The composer clears only on acceptance, so the text stays there to retry.
  expect(onAccepted).not.toHaveBeenCalled();
  expect(shownCount(result.current.messages, "Do not lose me")).toBe(0);
  expect(result.current.messages.some((message) => message.id === "canonical-safe-error")).toBe(true);
  expect(result.current.sessionId).toBeUndefined();
});

it("shows a follow-up while its attachment is still uploading", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const upload = gate();
  const { chat } = fixtureServer({ uploadGate: upload.opened });
  const { result } = renderHook(() => useCanonicalChatState({}));
  await act(async () => { result.current.switchConversation(chat.id); });
  await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));

  const files = [{ name: "notes.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=" }];
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("See attached", files, options); });
  await waitFor(() => expect(shownCount(result.current.messages, "See attached")).toBe(1));

  upload.release();
  await act(async () => { expect(await sending).toBe(true); });
  expect(shownCount(result.current.messages, "See attached")).toBe(1);
});

it.each([
  { streamOpen: true, draft: false }, { streamOpen: true, draft: true },
  { streamOpen: false, draft: false },
])("re-reads after a send only without a live event stream, except one detail read for a new Chat (open: $streamOpen, new Chat: $draft)", async ({ streamOpen, draft }) => {
  vi.stubGlobal("crypto", webcrypto);
  const { chat, reads } = fixtureServer({ streamOpen });
  const { result } = renderHook(() => useCanonicalChatState(draft ? { initialDraft: "Hello" } : {}));
  if (!draft) {
    await act(async () => { result.current.switchConversation(chat.id); });
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
  }
  await waitFor(() => expect(reads.list).toBeGreaterThan(0));
  // Let the connection state settle before measuring.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const before = { ...reads };

  await act(async () => { expect(await result.current.submitMessage("Hello", undefined, options)).toBe(true); });
  expect(result.current.sessionId).toBe(chat.id);
  expect(shownCount(result.current.messages, "Hello")).toBe(1);
  if (streamOpen) {
    // A new Chat reads its detail once: its events may have passed while unselected.
    expect(reads.list).toBe(before.list);
    expect(reads.detail).toBe(before.detail + (draft ? 1 : 0));
  } else {
    expect(reads.list).toBeGreaterThan(before.list);
    expect(reads.detail).toBeGreaterThan(before.detail);
  }
});

it("keeps a fast reply when an event-driven read confirms a new Chat's send before its response", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _activeRun, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let full: unknown = null;
  const response = gate();
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode([{ type: "chat.stream.attached" }, { type: "chat.replay.end" }]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/chats?") && init?.method === "POST") return Response.json({ chat: { ...chat, revision: 0, messageCount: 0 } });
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const message = { ...snapshot.messages[0]!, id: "msg_sent", seq: 1, role: "user" as const, state: "committed" as const, turnId: "cturn_sent", runId: undefined, parts: body.parts };
      const reply = { ...snapshot.messages[0]!, id: "msg_reply", seq: 2, role: "assistant" as const, state: "committed" as const, turnId: "cturn_sent", runId: "run_sent",
        parts: [{ type: "text" as const, text: "Fast reply" }] };
      const turn = { ...snapshot.turns[0]!, id: "cturn_sent", clientRequestId: body.clientRequestId, inputMessageId: "msg_sent", baseMessageSeq: 0 };
      const run = { ...snapshot.runs[0]!, id: "run_sent", turnId: "cturn_sent" };
      const admittedRecord = { chat: { ...chat, revision: 1, messageCount: 1 } };
      // The run completes before the admission response arrives.
      const latest = { chat: { ...chat, revision: 3, messageCount: 2 } };
      full = { record: latest, messages: [message, reply], turns: [turn], runs: [run], activities: [] };
      stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chat.event", event: {
        cursor: 1, chatId: chat.id, revision: 3, eventType: "turn.accepted", createdAt: chat.createdAt } })}\n\n`));
      await response.opened;
      return Response.json({ record: admittedRecord, message, turn, run, admission: "accepted" });
    }
    if (url.includes("/api/chats?")) return Response.json({ items: [{ chat }] });
    return Response.json(full ?? { record: { chat }, messages: [], turns: [], runs: [], activities: [] });
  }));
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "Hello" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("Hello", undefined, options); });
  await waitFor(() => expect(result.current.sessionId).toBe(chat.id));
  response.release();
  await act(async () => { expect(await sending).toBe(true); });
  await waitFor(() => expect(result.current.messages.some((message) => message.role === "assistant" && String(message.content).includes("Fast reply"))).toBe(true));
  expect(shownCount(result.current.messages, "Hello")).toBe(1);
});

it("shows a fast first reply when the send response beats the event-driven read on a new Chat", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _activeRun, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let full: unknown = null;
  const eventRead = gate();
  const eventReadStarted = gate();
  let gatedRead = false;
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode([{ type: "chat.stream.attached" }, { type: "chat.replay.end" }]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/chats?") && init?.method === "POST") return Response.json({ chat: { ...chat, revision: 0, messageCount: 0 } });
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const message = { ...snapshot.messages[0]!, id: "msg_sent", seq: 1, role: "user" as const, state: "committed" as const, turnId: "cturn_sent", runId: undefined, parts: body.parts };
      const reply = { ...snapshot.messages[0]!, id: "msg_reply", seq: 2, role: "assistant" as const, state: "committed" as const, turnId: "cturn_sent", runId: "run_sent",
        parts: [{ type: "text" as const, text: "Fast reply" }] };
      const turn = { ...snapshot.turns[0]!, id: "cturn_sent", clientRequestId: body.clientRequestId, inputMessageId: "msg_sent", baseMessageSeq: 0 };
      const run = { ...snapshot.runs[0]!, id: "run_sent", turnId: "cturn_sent" };
      // The run completes and its events pass while the new Chat is not yet selected.
      full = { record: { chat: { ...chat, revision: 3, messageCount: 2 } }, messages: [message, reply], turns: [turn], runs: [run], activities: [] };
      stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chat.event", event: {
        cursor: 1, chatId: chat.id, revision: 3, eventType: "turn.accepted", createdAt: chat.createdAt } })}\n\n`));
      // The send response arrives while the event-triggered detail read is still in flight.
      await eventReadStarted.opened;
      return Response.json({ record: { chat: { ...chat, revision: 1, messageCount: 1 } }, message, turn, run, admission: "accepted" });
    }
    if (url.includes("/api/chats?")) return Response.json({ items: [{ chat }] });
    if (full && !gatedRead) {
      gatedRead = true;
      eventReadStarted.release();
      await eventRead.opened;
    }
    return Response.json(full ?? { record: { chat }, messages: [], turns: [], runs: [], activities: [] });
  }));
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "Hello" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  await act(async () => { expect(await result.current.submitMessage("Hello", undefined, options)).toBe(true); });
  expect(result.current.sessionId).toBe(chat.id);
  eventRead.release();
  await waitFor(() => expect(result.current.messages.some((message) => message.role === "assistant" && String(message.content).includes("Fast reply"))).toBe(true));
  expect(shownCount(result.current.messages, "Hello")).toBe(1);
});

it("does not carry a pending draft send into the next New Chat", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const create = gate();
  fixtureServer({ createGate: create.opened });
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "Old words" }));

  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("Old words", undefined, options); });
  await waitFor(() => expect(shownCount(result.current.messages, "Old words")).toBe(1));
  await act(async () => { await result.current.newChat(); });
  expect(shownCount(result.current.messages, "Old words")).toBe(0);

  // The old send keeps running; its later updates stay out of the new draft.
  create.release();
  await act(async () => { await sending; });
  expect(result.current.sessionId === undefined ? shownCount(result.current.messages, "Old words") : 0).toBe(0);
});
