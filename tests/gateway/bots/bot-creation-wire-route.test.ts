import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CanonicalChatRecordSchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../../packages/gateway/src/chat/routes.js";
import { registerCanonicalChatEventHttpRoute } from "../../../packages/gateway/src/chat/event-http-route.js";
const stamp = "2026-10-14T00:00:00.000Z";
const record = CanonicalChatRecordSchema.parse({ chat: { id: "chat_wire", ownerScope: { type: "personal", ownerId: "owner" }, title: "Wire", lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: stamp, updatedAt: stamp } });
const proposal: CanonicalChatRunActivity = { type: "bot.draft.proposed", id: "activity_wire", chatId: "chat_wire", runId: "run_wire", occurredAt: stamp, proposalId: "proposal_wire", sessionId: "creation_wire", baseDraftRevision: 0, patch: { name: "Planner" } };
const detail = { record, messages: [], turns: [], runs: [], activities: [proposal] };
it.each([undefined, "0", "1"])("negotiates HTTP activity projection at Bot drafting wire %s", async version => {
  const app = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }), service: { getDetail: async () => detail } as unknown as CanonicalChatRouteService });
  const response = await app.request(`/api/chats/chat_wire${version === undefined ? "" : `?botCreationVersion=${version}`}`);
  expect(response.status).toBe(200);
  expect((await response.json()).activities).toEqual(version === "1" ? [proposal] : []);
});
it.each([undefined, "0", "1"])("negotiates live/replay SSE activity projection at Bot drafting wire %s", async version => {
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }), stream: { open: async ({ sink }) => {
    sink.send({ type: "chat.content", event: { cursor: 1, chatId: "chat_wire", revision: 0, eventType: "run.activity", createdAt: stamp }, content: detail });
    return { onClose() {}, touch() {} };
  } }, setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn() });
  const response = await app.request(`/api/chats/events?messageVersion=2&inputVersion=1${version === undefined ? "" : `&botCreationVersion=${version}`}`, { headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } });
  const reader = response.body!.getReader();
  try {
    const frame = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!.trim());
    expect(frame.content.activities).toEqual(version === "1" ? [proposal] : []);
  } finally { await reader.cancel(); }
});
it.each(["2", "1&botCreationVersion=0"])("rejects unsupported/duplicate drafting versions before transport attach", async version => {
  const getDetail = vi.fn();
  const app = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }), service: { getDetail } as unknown as CanonicalChatRouteService });
  expect((await app.request(`/api/chats/chat_wire?botCreationVersion=${version}`)).status).toBe(400);
  expect(getDetail).not.toHaveBeenCalled();
});
