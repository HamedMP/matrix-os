import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { toMessage } from "../../packages/gateway/src/chat/records";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { Hono } from "hono";
import { CanonicalChatMessageSchema, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes";

// Frozen field set from Desktop 0.1.0-canary.20260908044406 (919eb2e6d).
// Reuse unchanged field validators, but never inherit newly added object keys.
const fields = CanonicalChatMessageSchema.shape;
const legacyDesktopMessage = z.object({
  id: fields.id, chatId: fields.chatId, seq: fields.seq, role: fields.role,
  state: fields.state, turnId: fields.turnId, runId: fields.runId,
  parts: fields.parts, createdAt: fields.createdAt,
}).strict();
const timestamp = "2026-09-09T00:00:00.000Z";
const detail: CanonicalChatDetailResponse = {
  record: { chat: { id: "chat_test", ownerScope: { type: "personal", ownerId: "owner" },
    title: "Compatibility", lifecycle: "active", attention: "none", revision: 1,
    messageCount: 1, createdAt: timestamp, updatedAt: timestamp } },
  messages: [toMessage({ id: "msg_test", chat_id: "chat_test", seq: 1, role: "user", state: "committed",
    actor_id: "owner", purpose: "ai_request", turn_id: null, run_id: null,
    parts: JSON.stringify([{ type: "text", text: "hello" }]), created_at: new Date(timestamp) })],
  turns: [], runs: [], activities: [],
};
function app() {
  return new Hono().route("/", createCanonicalChatRoutes({
    service: { getDetail: async () => detail } as unknown as CanonicalChatRouteService,
    getPrincipal: () => ({ userId: "owner", source: "jwt" }),
  }));
}

describe("released Desktop message compatibility", () => {
  it("keeps unversioned Chat detail readable by the affected released parser", async () => {
    const response = await app().request("/api/chats/chat_test");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(legacyDesktopMessage.safeParse(body.messages[0]).success).toBe(true);
    expect(body.messages[0].parts).toEqual(detail.messages[0].parts);
    expect(detail.messages[0].purpose).toBe("ai_request");
  });
  it("retains actor and purpose for a client that opts into message version 2", async () => {
    const response = await app().request("/api/chats/chat_test?messageVersion=2");
    expect(response.status).toBe(200);
    expect((await response.json()).messages[0]).toEqual(detail.messages[0]);
  });
  it("rejects an unsupported message version before executing the request", async () => {
    const response = await app().request("/api/chats/chat_test?messageVersion=99");
    expect(response.status).toBe(400);
  });
});


it.each([undefined, "1", "2"])("negotiates message metadata in SSE snapshots and deltas (%s)", async (version) => {
  const app = new Hono();
  const message = { ...detail.messages[0]!, role: "assistant" as const, state: "pending" as const, purpose: "assistant" as const };
  const content = { record: detail.record, messages: [message], messageDelta: { message, partIndex: 0, offset: 0 } };
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    stream: { open: async ({ sink }) => {
      sink.send({ type: "chat.content", event: { cursor: 1, chatId: "chat_test", revision: 1, eventType: "chat.updated", createdAt: timestamp }, content });
      return { onClose() {}, touch() {} };
    } },
    setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn(),
  });
  const response = await app.request(`/api/chats/events${version ? `?messageVersion=${version}` : ""}`, {
    headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    const text = new TextDecoder().decode((await reader.read()).value);
    const frame = JSON.parse(text.split("data: ")[1]!.trim());
    for (const output of [frame.content.messages[0], frame.content.messageDelta.message]) {
      if (version === "2") expect(output).toEqual(message);
      else expect(legacyDesktopMessage.safeParse(output).success).toBe(true);
    }
    expect(content.messageDelta.message.purpose).toBe("assistant");
  } finally { await reader.cancel(); }
});

it.each(["turn", "steer", "queued-steer"])("preserves the old parser for %s responses", async (operation) => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const message = { ...snapshot.messages[0]!, actorId: "owner", purpose: "ai_request" as const, runId: snapshot.runs[0]!.id };
  const chat = { ...detail.record.chat, id: message.chatId };
  const run = snapshot.runs[0]!;
  const turn = snapshot.turns[0]!;
  const service = {
    admitTurn: async () => ({ record: { chat }, message, run, turn, admission: "accepted" }),
    steerRun: async () => ({ runId: run.id, turnId: turn.id, message, steering: "accepted" }),
    steerQueuedTurn: async () => ({ runId: run.id, turnId: turn.id, message, steering: "accepted" }),
  } as unknown as CanonicalChatRouteService;
  const app = new Hono().route("/", createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: "owner", source: "jwt" }) }));
  const suffix = operation === "turn" ? "turns" : `runs/${run.id}/${operation === "queued-steer" ? "queued-turns/qturn_test/" : ""}steer`;
  const body = { clientRequestId: "req_compatibility",
    ...(operation === "steer" ? {} : { baseRevision: 1 }),
    ...(operation === "turn" ? {} : { expectedTurnId: turn.id }),
    ...(operation === "queued-steer" ? {} : { parts: [{ type: "text", text: "hello" }] }),
    ...(operation === "turn" ? { selection: run.selection, interactionMode: "default", permissionMode: "supervised" } : {}),
  };
  for (const version of ["1", "2"]) {
    const response = await app.request(`/api/chats/${chat.id}/${suffix}?messageVersion=${version}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(operation === "turn" ? 202 : 200);
    const output = (await response.json()).message;
    if (version === "2") expect(output).toEqual(message);
    else expect(legacyDesktopMessage.safeParse(output).success).toBe(true);
  }
});
