import { z } from "zod/v4";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CanonicalChatRecordSchema } from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";

const stamp = "2026-09-16T00:00:00.000Z";
const record = { chat: { id: "chat_wire", ownerScope: { type: "personal", ownerId: "owner" }, title: "Wire",
  lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: stamp, updatedAt: stamp, titleVersion: 2, activityAt: stamp },
  readState: { unread: true, markedUnread: true, version: 1, readThroughSeq: 0, latestIncomingSeq: 0 } };
// Freeze the released field set rather than inheriting new keys.
const fields = CanonicalChatRecordSchema.shape;
const legacy = z.object({ chat: fields.chat.omit({ titleVersion: true, activityAt: true }), projectId: fields.projectId, providerBinding: fields.providerBinding, activeRun: fields.activeRun, latestSuccessfulCompletion: fields.latestSuccessfulCompletion }).strict();
const detail = { record, messages: [], turns: [], runs: [], activities: [] };

it.each([undefined, "0", "1"].flatMap(version => ["0", "1"].map(metadata => ({ version, metadata }))))("negotiates read state and metadata for HTTP ($version/$metadata)", async ({ version, metadata }) => {
  const app = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    service: { list: async () => ({ items: [record] }), getDetail: async () => detail,
      create: async () => record, updateTitle: async () => record } as unknown as CanonicalChatRouteService });
  const suffix = version === undefined ? "" : `?readStateVersion=${version}`;
  const headers = { "content-type": "application/json", "x-matrix-chat-metadata": metadata };
  const responses = [
    (await (await app.request(`/api/chats${suffix}`, { headers })).json()).items[0],
    (await (await app.request(`/api/chats/chat_wire${suffix}`, { headers })).json()).record,
    await (await app.request(`/api/chats${suffix}`, { method: "POST", headers,
      body: JSON.stringify({ clientRequestId: "req_wire", title: "Wire" }) })).json(),
    await (await app.request(`/api/chats/chat_wire/title${suffix}`, { method: "PATCH", headers,
      body: JSON.stringify({ title: "Renamed", expectedTitleVersion: 2 }) })).json(),
  ];
  for (const value of responses) {
    if (version === "1") expect(value.readState).toEqual(record.readState);
    else expect(value.readState).toBeUndefined();
    expect(value.chat.titleVersion).toBe(metadata === "1" ? 2 : undefined);
    if (metadata === "0" && version !== "1") expect(legacy.safeParse(value).success).toBe(true);
  }
  expect(record.readState.markedUnread).toBe(true);
});

it.each([undefined, "0", "1"].flatMap(version => ["0", "1"].map(metadata => ({ version, metadata }))))("negotiates read state and metadata for SSE ($version/$metadata)", async ({ version, metadata }) => {
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    stream: { open: async ({ sink }) => {
      sink.send({ type: "chat.content", event: { cursor: 1, chatId: "chat_wire", revision: 0, eventType: "chat.updated", createdAt: stamp }, content: { record: CanonicalChatRecordSchema.parse(record) } });
      return { onClose() {}, touch() {} };
    } }, setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn() });
  const response = await app.request(`/api/chats/events?messageVersion=2&inputVersion=1${version === undefined ? "" : `&readStateVersion=${version}`}`, {
    headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2", "x-matrix-chat-metadata": metadata },
  });
  const reader = response.body!.getReader();
  try {
    const frame = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!.trim());
    if (version === "1") expect(frame.content.record.readState).toEqual(record.readState);
    else expect(frame.content.record.readState).toBeUndefined();
    expect(frame.content.record.chat.titleVersion).toBe(metadata === "1" ? 2 : undefined);
    if (metadata === "0" && version !== "1") expect(legacy.safeParse(frame.content.record).success).toBe(true);
  } finally { await reader.cancel(); }
});

it("rejects unsupported read versions before invoking services or streams", async () => {
  const list = vi.fn();
  const routes = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    service: { list } as unknown as CanonicalChatRouteService });
  expect((await routes.request("/api/chats?readStateVersion=2")).status).toBe(400);
  expect(list).not.toHaveBeenCalled();
  const open = vi.fn();
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }), stream: { open } });
  expect((await app.request("/api/chats/events?readStateVersion=2", { headers: { accept: "text/event-stream" } })).status).toBe(400);
  expect(open).not.toHaveBeenCalled();
});

it("keeps Electron mention search compatible with the real strict query route", async () => {
  const { createCanonicalChatClient } = await import("../../desktop/src/renderer/src/lib/canonical-chat-client");
  const { createChatAgentRoutes } = await import("../../packages/gateway/src/chat/agent-routes");
  const app = createChatAgentRoutes({ enabled: () => false, catalog: { getCatalog: vi.fn() },
    getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
  const get = vi.fn(async (path: string) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    return response.json();
  });
  const client = createCanonicalChatClient({ get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() });
  await expect(client.agents!.search("todo", "chat_wire")).resolves.toEqual({ enabled: false, resources: [] });
  expect(get).toHaveBeenCalledWith("/api/chat-mentions?query=todo&chatId=chat_wire");
});
