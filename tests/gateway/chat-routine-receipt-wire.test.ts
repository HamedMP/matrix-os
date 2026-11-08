import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatMessageSchema,
  CanonicalChatTransportFrameSchema,
  chatMessageVersionUrl,
} from "@matrix-os/contracts";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { ReleasedChatTextPartSchema } from "../fixtures/desktop-v0.1.19/chat-message-text-part.js";

const timestamp = "2026-11-06T00:00:00.000Z";
const chatId = "chat_receipt";
const principal = { userId: "owner", source: "jwt" } as const;
const receipt = {
  type: "routine_receipt", engine: "matrix", kind: "output", status: "completed", attempt: 1,
  routineId: "rt_" + "a".repeat(24), fireId: "fire_" + "b".repeat(24), scheduledFor: timestamp,
  canonicalChatId: "chat_worker", canonicalTaskId: "task_worker", model: "test-model",
};
const text = { type: "text", text: "Scheduled result" };
const message = CanonicalChatMessageSchema.parse({
  id: "msg_receipt", chatId, seq: 1, role: "system", state: "committed", purpose: "system",
  createdAt: timestamp, parts: [receipt, text],
});
const detail = CanonicalChatDetailResponseSchema.parse({
  record: { chat: { id: chatId, ownerScope: { type: "personal", ownerId: principal.userId },
    title: "Receipt compatibility", lifecycle: "active", attention: "none", revision: 1,
    messageCount: 1, createdAt: timestamp, updatedAt: timestamp } },
  messages: [message], turns: [], runs: [], activities: [],
});
const frame = CanonicalChatTransportFrameSchema.parse({
  type: "chat.content",
  event: { cursor: 1, chatId, revision: 1, eventType: "chat.updated", createdAt: timestamp },
  content: detail,
});

function detailApp(getDetail = vi.fn(async () => detail)) {
  return new Hono().route("/", createCanonicalChatRoutes({
    service: { getDetail } as unknown as CanonicalChatRouteService,
    getPrincipal: () => principal,
  }));
}

function eventApp() {
  const app = new Hono();
  const open = vi.fn<Parameters<typeof registerCanonicalChatEventHttpRoute>[0]["stream"]["open"]>(
    async ({ sink }) => {
      sink.send(frame);
      return { onClose() {}, touch() {} };
    },
  );
  registerCanonicalChatEventHttpRoute({
    app, stream: { open }, getPrincipal: () => principal,
    setIntervalFn: () => 1, clearIntervalFn: vi.fn(),
  });
  return { app, open };
}

it("keeps REST history readable by a released message-v2 client and preserves opted-in provenance", async () => {
  const app = detailApp();
  const path = "/api/chats/" + chatId;
  const legacy = await app.request(path + "?messageVersion=2&assistantTextVersion=1");
  const modern = await app.request(chatMessageVersionUrl(path));
  expect(legacy.status).toBe(200);
  expect(modern.status).toBe(200);
  const legacyMessage = (await legacy.json()).messages[0];
  expect(legacyMessage).toEqual({ ...message, parts: [text] });
  expect(ReleasedChatTextPartSchema.array().parse(legacyMessage.parts)).toEqual([text]);
  expect((await modern.json()).messages[0]).toEqual(message);
  expect(detail.messages[0]?.parts).toEqual([receipt, text]);
});

it.each([false, true])("projects live receipts by the independent capability (opted in: %s)", async (opted) => {
  const { app } = eventApp();
  const path = "/api/chats/events";
  const response = await app.request(opted ? chatMessageVersionUrl(path) : path + "?messageVersion=2&assistantTextVersion=1", {
    headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    const body = new TextDecoder().decode((await reader.read()).value);
    const projected = JSON.parse(body.split("data: ")[1]!.trim());
    expect(projected).toMatchObject({ type: "chat.content", content: {
      messages: [{ ...message, parts: opted ? [receipt, text] : [text] }],
    } });
  } finally {
    await reader.cancel();
  }
});

it.each(["routineReceiptVersion=2", "routineReceiptVersion=1&routineReceiptVersion=1"])(
  "rejects an unsupported receipt capability before REST reads or stream open (%s)",
  async (query) => {
    const getDetail = vi.fn(async () => detail);
    const { app, open } = eventApp();
    expect((await detailApp(getDetail).request("/api/chats/" + chatId + "?" + query)).status).toBe(400);
    expect((await app.request("/api/chats/events?" + query, { headers: { accept: "text/event-stream" } })).status).toBe(400);
    expect(getDetail).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);
