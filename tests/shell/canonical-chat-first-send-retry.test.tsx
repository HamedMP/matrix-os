// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { stubLegacyChatFetch } from "./legacy-navigation-fetch-fixture";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { instanceId: "codex_fixture", model: "gpt-5.6-sol", interactionMode: "default", permissionMode: "supervised" };

it.each([
  { lostResponse: "create", attachment: false }, { lostResponse: "admission", attachment: false },
  { lostResponse: "admission", attachment: true },
])("retries an ordinary first send after a lost $lostResponse response (attachment: $attachment)", async ({ lostResponse, attachment }) => {
  vi.stubGlobal("crypto", webcrypto);
  const { snapshot } = createCanonicalChatFixture("running");
  const { activeRun, providerBinding, project, ...chat } = snapshot.chat;
  const created = { chat: { ...chat, revision: 0 } };
  const accepted = { record: { chat, activeRun, providerBinding }, message: snapshot.messages[0],
    turn: snapshot.turns[0], run: snapshot.runs[0], admission: "already_accepted" };
  const createdChats = new Map<string, string>();
  const admittedTurns = new Set<string>();
  const createKeys: string[] = [];
  const admissionKeys: string[] = [];
  const uploadedPaths: string[] = [];
  const files = attachment ? [{ name: "notes.txt", type: "text/plain", data: "data:text/plain;base64,aGVsbG8=" }] : undefined;
  let readbackAvailable = false;
  let lose = true;
  stubLegacyChatFetch(vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/files/blob?")) {
      const path = new URL(url).searchParams.get("path")!;
      uploadedPaths.push(path);
      return Response.json({ ok: true, path, size: 5 });
    }
    if (url.includes("/events?")) return new Response(new ReadableStream());
    if (url.includes("/api/chats?") && init?.method !== "POST") return Response.json({ items: readbackAvailable ? [accepted.record] : [] });
    if (url.includes("/api/chats?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      createKeys.push(body.clientRequestId);
      if (!createdChats.has(body.clientRequestId)) createdChats.set(body.clientRequestId, `chat_created_${createdChats.size}`);
      const id = createdChats.get(body.clientRequestId)!;
      created.chat.id = id;
      accepted.record.chat.id = id;
      accepted.message.chatId = id;
      accepted.turn.chatId = id;
      accepted.run.chatId = id;
      if (lose && lostResponse === "create") { lose = false; throw new TypeError("Lost create acknowledgement"); }
      return Response.json(created);
    }
    if (url.includes("/turns?") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      admissionKeys.push(body.clientRequestId);
      admittedTurns.add(`${accepted.record.chat.id}:${body.clientRequestId}`);
      accepted.turn.clientRequestId = body.clientRequestId;
      accepted.message.parts = body.parts;
      if (lose) { lose = false; throw new TypeError("Lost admission acknowledgement"); }
      readbackAvailable = true;
      return Response.json(accepted);
    }
    if (!readbackAvailable) throw new TypeError("Readback offline");
    return Response.json({ record: accepted.record, messages: [accepted.message], turns: [accepted.turn], runs: [accepted.run], activities: [] });
  }));
  const { result } = renderHook(() => useCanonicalChatState({ initialDraft: "Send once" }));
  await act(async () => { expect(await result.current.submitMessage("Send once", files, options)).toBe(false); });
  expect(result.current.sessionId).toBeUndefined();
  await act(async () => { expect(await result.current.submitMessage("Send once", files, options)).toBe(true); });
  expect(createdChats.size).toBe(1);
  expect(new Set(createKeys).size).toBe(1);
  expect(admittedTurns.size).toBe(1);
  expect(new Set(admissionKeys).size).toBe(1);
  if (attachment) {
    expect(uploadedPaths).toHaveLength(2);
    expect(new Set(uploadedPaths).size).toBe(1);
  }
  expect(result.current.sessionId).toBe(created.chat.id);
});
