// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { canonicalChatProviderCatalogPath } from "@matrix-os/ui";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { ChatInput } from "../../shell/src/components/chat/ChatInput";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

// ENG-540: on a new Chat the sent message stayed invisible for 1.8-3.1 s while
// the Chat was created and its turn admitted, and every send re-read the list
// and the detail even though the event stream already carried the changes.

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
vi.mock("@clerk/nextjs", async original => ({ ...(await original<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => children,
}));
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

function fixtureServer({ createGate, uploadGate, admitGate, createFails, firstCreateFails, streamOpen = false }: {
  createGate?: Promise<void>; uploadGate?: Promise<void>; admitGate?: Promise<void>; createFails?: boolean; firstCreateFails?: boolean; streamOpen?: boolean;
} = {}) {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _activeRun, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
  const record = { chat };
  const existing = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [] };
  let admitted: typeof existing | null = null;
  const reads = { list: 0, detail: 0 };
  const createRequestIds: string[] = [];
  const uploadedPaths: string[] = [];
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(canonicalChatProviderCatalogPath())) return Response.json(createCanonicalProviderCatalogFixture());
    if (url.includes("/events?")) return streamOpen ? attachedStream() : new Response(new ReadableStream());
    if (url.includes("/api/files/blob?")) {
      await uploadGate;
      const path = new URL(url).searchParams.get("path")!;
      uploadedPaths.push(path);
      return Response.json({ ok: true, path, size: 5 });
    }
    if (url.includes("/api/chats?") && init?.method === "POST") {
      createRequestIds.push(JSON.parse(init.body as string).clientRequestId);
      await createGate;
      if (createFails || (firstCreateFails && createRequestIds.length === 1)) {
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      }
      return Response.json({ chat: { ...chat, revision: 0, messageCount: 0 } });
    }
    if (url.includes("/turns?") && init?.method === "POST") {
      await admitGate;
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
  return { chat, reads, createRequestIds, uploadedPaths };
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

// The composer and the hook together, as ChatApp wires them: the sent text
// leaves the composer when its pending message shows, not ~2 s later on
// acceptance, so the owner never sees it twice.
function WebChat({ chatId }: { chatId?: string }) {
  const state = useCanonicalChatState(chatId ? {} : { initialDraft: "draft" });
  const composer = useChatComposerDraft(state.sessionId ?? "new", "owner");
  return <>
    <ul aria-label="Transcript">{state.messages.filter((message) => message.role === "user")
      .map((message) => <li key={message.id}>{String(message.content)}</li>)}</ul>
    {chatId && !state.sessionId ? <button type="button" onClick={() => state.switchConversation(chatId)}>Open</button> : null}
    <ChatInput key={state.sessionId ?? "new"} composer={composer} scope={state.sessionId ?? "new"} permissionMode="supervised" connected busy={false}
      attachmentsEnabled={false} onSubmit={(text, files, submit) => state.submitMessage(text, files, { ...options, ...submit })} />
  </>;
}
const composerValue = () => (screen.getByPlaceholderText("Reply to chat…") as HTMLTextAreaElement).value;
const transcriptText = () => screen.getByRole("list", { name: "Transcript" }).textContent;

async function sendFromComposer(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Reply to chat…"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

it("empties the composer when a new Chat's pending message shows, before the Chat exists", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const create = gate();
  fixtureServer({ createGate: create.opened });
  render(<WebChat />);
  await sendFromComposer("Plan the launch");

  await waitFor(() => expect(transcriptText()).toContain("Plan the launch"));
  expect(composerValue()).toBe("");

  create.release();
  await waitFor(() => expect(screen.getByRole("list", { name: "Transcript" }).children.length).toBe(1));
  expect(composerValue()).toBe("");
});

it("empties the composer when a follow-up's pending message shows, before admission", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const admit = gate();
  const { chat } = fixtureServer({ admitGate: admit.opened });
  render(<WebChat chatId={chat.id} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(transcriptText()).not.toBe(""));
  const before = screen.getByRole("list", { name: "Transcript" }).children.length;
  await sendFromComposer("One more thing");

  await waitFor(() => expect(transcriptText()).toContain("One more thing"));
  expect(composerValue()).toBe("");
  admit.release();
  await waitFor(() => expect(screen.getByRole("list", { name: "Transcript" }).children.length).toBe(before + 1));
  expect(composerValue()).toBe("");
});

function ChatScreen({ draft = false }: { draft?: boolean }) {
  const state = useCanonicalChatState(draft ? { initialDraft: "draft" } : {});
  return <>
    <output data-testid="selected-chat">{state.sessionId}</output>
    <ChatApp messages={state.messages} sessionId={state.sessionId} busy={state.busy} connected
      composerIdentity={state.composerIdentity} conversations={state.conversations} onNewChat={state.createChat}
      onSwitchConversation={state.switchConversation} onSubmit={state.submitMessage}
      providerSelection={state.providerSelection} />
  </>;
}

function setupChatScreen() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
}

it("carries a follow-up draft into the Chat when its first send succeeds", async () => {
  setupChatScreen();
  const admission = gate();
  const { chat } = fixtureServer({ admitGate: admission.opened, streamOpen: true });
  render(<ChatScreen draft />);
  const initialEditor = await screen.findByPlaceholderText("How can I help you today?");
  fireEvent.change(initialEditor, { target: { value: "First admitted message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("First admitted message", { exact: true, selector: "span" });
  const pendingEditor = screen.getByPlaceholderText("Reply to chat…");
  expect(pendingEditor).not.toBe(initialEditor);
  expect(composerValue()).toBe("");
  fireEvent.change(pendingEditor, { target: { value: "Follow-up while sending" } });
  admission.release();

  await waitFor(() => expect(screen.getByTestId("selected-chat").textContent).toBe(chat.id));
  expect(composerValue()).toBe("Follow-up while sending");
  expect(screen.queryByText("Follow-up while sending", { exact: true, selector: "span" })).toBeNull();
});

it.each([false, true])("replays an unconfirmed admission after a model change (newer draft=%s)", async (typed) => {
  setupChatScreen();
  const admission = gate();
  const catalog = createCanonicalProviderCatalogFixture();
  const instance = catalog.instances[0]!;
  const originalModel = instance.models[0]!;
  instance.models.push({ ...originalModel, id: "retry-fixture-model", displayName: "Retry fixture model" });
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _active, providerBinding: _binding, project: _project, ...chat } = snapshot.chat;
  let revision = chat.revision;
  const record = () => ({ chat: { ...chat, revision } });
  const requests: unknown[] = [];
  const reads: number[] = [];
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(canonicalChatProviderCatalogPath())) return Response.json(catalog);
    if (url.includes("/events?")) return attachedStream();
    if (url.includes("/api/chats?")) return Response.json({ items: [record()] });
    if (url.includes("/turns?") && init?.method === "POST") {
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 1) {
        await admission.opened;
        throw new TypeError("Acknowledgement unavailable");
      }
      return Response.json({ error: { code: "conflict" } }, { status: 409 });
    }
    if (url.includes(`/api/chats/${chat.id}?`)) {
      reads.push(revision);
      return Response.json({ record: record(), messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [] });
    }
    return Response.json({});
  }));
  render(<ChatScreen />);
  await waitFor(() => expect(screen.getByTestId("selected-chat").textContent).toBe(chat.id));
  const editor = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(editor, { target: { value: "Run this once" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Run this once", { exact: true, selector: "span" });
  if (typed) fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "My separate follow-up" } });
  admission.release();
  const retry = await screen.findByRole("button", { name: "Retry message" });
  expect(requests).toHaveLength(1);

  // The refreshed transcript does not contain the uncertain admission's receipt.
  revision += 3;
  await act(async () => { fireEvent.focus(window); });
  await waitFor(() => expect(reads).toContain(revision));
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  fireEvent.click(await screen.findByText("Retry fixture model", { exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-model")).toBe("retry-fixture-model"));
  fireEvent.click(retry);
  await waitFor(() => expect(requests).toHaveLength(2));

  expect(requests[0]).toMatchObject({ selection: { model: originalModel.id }, baseRevision: chat.revision });
  expect(requests[1]).toEqual(requests[0]);
  expect(composerValue()).toBe(typed ? "My separate follow-up" : "");
});

it.each([
  { typed: false, attached: false },
  { typed: true, attached: false },
  { typed: true, attached: true },
])("keeps a rejected first message retryable across composer mounts (typed=$typed, attached=$attached)", async ({ typed, attached }) => {
  setupChatScreen();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const create = gate();
  const { chat, createRequestIds, uploadedPaths } = fixtureServer({ createGate: create.opened, firstCreateFails: true });
  render(<ChatScreen draft />);
  const newChatInput = await screen.findByPlaceholderText("How can I help you today?");
  fireEvent.change(newChatInput, { target: { value: "Do not lose me" } });
  if (attached) {
    const fileInput = screen.getByLabelText("Attach files", { selector: "input" });
    fireEvent.change(fileInput, { target: { files: [new File(["hello"], "retry-notes.txt", { type: "text/plain" })] } });
  }
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).toHaveProperty("disabled", false));
  fireEvent.click(send);
  await screen.findByText("Do not lose me", { exact: true, selector: "span" });
  const pendingInput = screen.getByPlaceholderText("Reply to chat…");
  expect(pendingInput).not.toBe(newChatInput);
  expect(composerValue()).toBe("");
  if (typed) fireEvent.change(pendingInput, { target: { value: "A newer thought" } });

  create.release();
  await waitFor(() => expect(screen.queryByText("Do not lose me", { exact: true, selector: "span" })).toBeNull());
  expect(composerValue()).toBe(typed ? "A newer thought" : "Do not lose me");
  fireEvent.click(screen.getByRole("button", { name: typed ? "Retry message" : "Send" }));
  await screen.findByText("Do not lose me", { exact: true, selector: "span" });
  await waitFor(() => expect(screen.getByTestId("selected-chat").textContent).toBe(chat.id));
  expect(createRequestIds).toHaveLength(2);
  expect(composerValue()).toBe(typed ? "A newer thought" : "");
  expect(createRequestIds[1]).toBe(createRequestIds[0]);
  expect(uploadedPaths).toHaveLength(attached ? 1 : 0);
  if (attached) expect(uploadedPaths[0]).toContain("retry-notes.txt");
  expect(screen.queryByText("A newer thought", { exact: true, selector: "span" })).toBeNull();
});
