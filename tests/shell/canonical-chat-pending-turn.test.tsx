// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";
import { CanonicalCreateChatTurnRequestSchema } from "@matrix-os/contracts";

// ENG-522: a follow-up stayed invisible until turn admission returned
// (0.9 s on Matrix AI, 3.9 s on Claude). It now shows the moment it is sent.

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { instanceId: "codex_fixture", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised" };

it("opens a first message while its admission response is still pending", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("idle");
  const { project, ...chat } = snapshot.chat;
  const record = { chat, projectId: project.projectId };
  const empty = { record, messages: [], turns: [], runs: [], activities: [] };
  let rejectAdmission!: () => void;
  const admission = new Promise<Response>(resolve => { rejectAdmission = () => resolve(Response.json({ error: { code: "invalid_request" } }, { status: 400 })); });
  const post = vi.fn();
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?") && init?.method === "POST") return Response.json(record);
    if (url.includes("/turns?") && init?.method === "POST") {
      post(CanonicalCreateChatTurnRequestSchema.parse(JSON.parse(init.body as string)));
      return admission;
    }
    if (url.includes("/api/chats?")) return Response.json({ items: [] });
    return Response.json(empty);
  }));
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "My first prompt" }));
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("My first prompt", undefined, options); });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  try {
    expect(result.current.sessionId).toBe(chat.id);
    expect(result.current.messages.filter(message => message.role === "user" && message.content === "My first prompt")).toHaveLength(1);
  } finally {
    await act(async () => { rejectAdmission(); await sending; });
  }
});

it("releases an accepted send while the subsequent navigation refresh is pending", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun: _activeRun, project, providerBinding, ...chat } = snapshot.chat;
  const record = { chat, projectId: project.projectId, providerBinding };
  let admitted = false;
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const onAccepted = vi.fn();
  const refreshStarted = vi.fn();
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = CanonicalCreateChatTurnRequestSchema.parse(JSON.parse(init.body as string));
      admitted = true;
      return Response.json({ record, message: { ...snapshot.messages[0], parts: body.parts },
        turn: { ...snapshot.turns[0], clientRequestId: body.clientRequestId }, run: snapshot.runs[0], admission: "accepted" });
    }
    if (admitted) { refreshStarted(); await refresh; }
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    return Response.json({ record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [] });
  }));
  const { result } = renderHook(() => useCanonicalChatState({}));
  await act(async () => { result.current.switchConversation(chat.id); });
  await waitFor(() => expect(result.current.busy).toBe(false));
  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("Accepted prompt", undefined, { ...options, onAccepted }); });
  await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(refreshStarted).toHaveBeenCalled());
  try {
    expect(result.current.busy).toBe(false);
  } finally {
    await act(async () => { releaseRefresh(); await sending; });
  }
});

it("shows a sent follow-up before admission returns, and once after", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("completed");
  const { activeRun, providerBinding, project, ...chat } = snapshot.chat;
  const record = { chat, ...(activeRun ? { activeRun } : {}), ...(providerBinding ? { providerBinding } : {}) };
  const detail = { record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [] };
  let releaseAdmission!: () => void;
  const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let admittedDetail: typeof detail | null = null;
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      await admissionGate;
      const message = { ...snapshot.messages[0]!, id: "msg_followup", seq: 99, role: "user" as const, state: "committed" as const, turnId: "cturn_followup", runId: undefined, parts: body.parts };
      const turn = { ...snapshot.turns[0]!, id: "cturn_followup", clientRequestId: body.clientRequestId, inputMessageId: "msg_followup", baseMessageSeq: 98 };
      const run = { ...snapshot.runs[0]!, id: "run_followup", turnId: "cturn_followup" };
      const next = { ...record, chat: { ...chat, revision: chat.revision + 1 } };
      admittedDetail = { record: next, messages: [...detail.messages, message], turns: [...detail.turns, turn], runs: [...detail.runs, run], activities: [] };
      return Response.json({ record: next, message, turn, run, admission: "accepted" });
    }
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    return Response.json(admittedDetail ?? detail);
  }));
  const { result } = renderHook(() => useCanonicalChatState({}));
  await act(async () => { result.current.switchConversation(chat.id); });
  await waitFor(() => expect(result.current.sessionId).toBe(chat.id));
  const shown = (text: string) => result.current.messages.filter((message) => message.role === "user" && String(message.content).includes(text)).length;

  let sending!: Promise<boolean>;
  act(() => { sending = result.current.submitMessage("Follow up please", undefined, options); });
  await waitFor(() => expect(shown("Follow up please")).toBe(1));
  releaseAdmission();
  await act(async () => { await sending; });
  expect(shown("Follow up please")).toBe(1);
});
