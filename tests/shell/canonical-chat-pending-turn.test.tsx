// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

// ENG-522: a follow-up stayed invisible until turn admission returned
// (0.9 s on Matrix AI, 3.9 s on Claude). It now shows the moment it is sent.

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { instanceId: "codex_fixture", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised" };

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
