import { z } from "zod/v4";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CanonicalChatRunSchema } from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const stamp = "2026-10-07T00:00:00.000Z";
const record = { chat: { id: "chat_wire", ownerScope: { type: "personal", ownerId: "owner" }, title: "Wire",
  lifecycle: "active", attention: "none", revision: 0, messageCount: 0, createdAt: stamp, updatedAt: stamp } };
const run = CanonicalChatRunSchema.parse({ ...createCanonicalChatFixture("running").snapshot.runs[0], chatId: "chat_wire",
  runPolicy: { memoryMode: "ordinary", source: "voice", nativeCheckpointPolicy: "disposable" },
  capabilitySnapshot: { ...createCanonicalChatFixture("running").snapshot.runs[0]!.capabilitySnapshot,
    cancellation: "run", approvalBinding: "argument_digest" } });
const { runPolicy: _runPolicy, ...oldFields } = CanonicalChatRunSchema.shape;
const { approvalBinding: _approvalBinding, ...oldCapabilities } = oldFields.capabilitySnapshot.shape;
const legacyRun = z.object({ ...oldFields, capabilitySnapshot: z.object({ ...oldCapabilities, cancellation: z.boolean() }).strict() }).strict();
const detail = { record, messages: [], turns: [], runs: [run], activities: [] };
const principal = () => ({ userId: "owner", source: "jwt" as const });

it.each([undefined, "0", "1"])("negotiates the strict run shape for HTTP detail and cancellation (%s)", async version => {
  const service = { getDetail: async () => detail, cancelRun: async () => ({ run, cancellation: "aborted", granularity: "run" }) } as unknown as CanonicalChatRouteService;
  const app = createCanonicalChatRoutes({ getPrincipal: principal, service });
  const suffix = version === undefined ? "" : `?runVersion=${version}`;
  const loaded = await (await app.request(`/api/chats/chat_wire${suffix}`)).json();
  const response = await app.request(`/api/chats/chat_wire/runs/${run.id}/cancel${suffix}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestId: "req_cancel_wire" }) });
  expect(response.status).toBe(200);
  const cancelled = await response.json();
  for (const value of [loaded.runs[0], cancelled.run]) {
    if (version === "1") expect(value).toEqual(run);
    else { expect(legacyRun.safeParse(value).success).toBe(true); expect(value.capabilitySnapshot.cancellation).toBe(true); }
  }
  expect(cancelled.granularity).toBe(version === "1" ? "run" : undefined);
});

it.each([undefined, "0", "1"])("negotiates the strict run shape for live SSE content (%s)", async version => {
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: principal,
    stream: { open: async ({ sink }) => {
      sink.send({ type: "chat.content", event: { cursor: 1, chatId: "chat_wire", revision: 0, eventType: "run.updated", createdAt: stamp },
        content: { record: record as never, runs: [run] } });
      return { onClose() {}, touch() {} };
    } }, setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn() });
  const response = await app.request(`/api/chats/events?messageVersion=2${version === undefined ? "" : `&runVersion=${version}`}`, {
    headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } });
  const reader = response.body!.getReader();
  try {
    const frame = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!.trim());
    const value = frame.content.runs[0];
    if (version === "1") expect(value).toEqual(run);
    else expect(legacyRun.safeParse(value).success).toBe(true);
  } finally { await reader.cancel(); }
});

it("rejects unsupported or repeated run versions before dispatching services or streams", async () => {
  const getDetail = vi.fn(); const open = vi.fn();
  const routes = createCanonicalChatRoutes({ getPrincipal: principal, service: { getDetail } as unknown as CanonicalChatRouteService });
  const app = new Hono(); registerCanonicalChatEventHttpRoute({ app, getPrincipal: principal, stream: { open } });
  for (const query of ["runVersion=2", "runVersion=0&runVersion=1"]) {
    expect((await routes.request(`/api/chats/chat_wire?${query}`)).status).toBe(400);
    expect((await app.request(`/api/chats/events?${query}`, { headers: { accept: "text/event-stream" } })).status).toBe(400);
  }
  expect(getDetail).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
