import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CanonicalChatTransportFrameSchema } from "@matrix-os/contracts";
import { fetchChatDetail, updateChatReadState } from "../../apps/mobile/lib/requests/canonical-chat";
import { createCanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support";

// HTTP dispatch/auth are local seams; the mobile serializer/parser, gateway,
// transactions, outbox, SSE negotiation and desktop consumer stay real.
let fixture: CollaborationTestDatabase;
let repository: ChatRepository;
let stream: ReturnType<typeof createCanonicalChatEventStream>;
let app: Hono;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
const owner = { type: "personal" as const, ownerId: "owner_mobile_read" };
const origin = "https://read-state.test";
const { snapshot } = createCanonicalChatFixture("running");
const chatId = snapshot.chat.id;
const token = "synthetic-owner-token";

beforeEach(async () => {
  fixture = await (process.env.MATRIX_TEST_POSTGRES_URL
    ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
  repository = new ChatRepository(fixture.db);
  await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_mobile_read", title: "Read on phone" });
  const run = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, status: "accepted" }, run: { ...run, status: "accepted" } });
  await repository.markRunRunning(owner, { chatId, runId: run.id, startedAt: run.createdAt });
  await repository.appendAssistantDelta(owner, { chatId, runId: run.id, messageId: "msg_mobile_reply", delta: "Read this reply.", createdAt: run.createdAt });
  await repository.finishRun(owner, { chatId, runId: run.id, outcome: "completed", completedAt: run.createdAt });
  stream = createCanonicalChatEventStream({ repository });
  app = new Hono();
  const getPrincipal = (context: import("hono").Context) => ({
    userId: context.req.header("authorization") === `Bearer ${token}` ? owner.ownerId : "other_owner", source: "jwt" as const,
  });
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal });
  app.route("/", createCanonicalChatRoutes({ service: createCanonicalChatService(repository), getPrincipal }));
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => app.fetch(new Request(String(input), init)));
});

afterEach(async () => {
  await reader?.cancel(); reader = undefined;
  stream?.shutdown();
  await fixture?.destroy();
  vi.restoreAllMocks();
});

function desktopRequest(path: string, method = "GET", body?: unknown) {
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async response => {
    expect(response.status).toBe(200);
    return response.json();
  });
}

it("a mobile HTTP acknowledgement persists the cursor and publishes the same cleared state to desktop and SSE", async () => {
  const desktop = createCanonicalChatClient({ get: desktopRequest, post: (path, body) => desktopRequest(path, "POST", body),
    patch: (path, body) => desktopRequest(path, "PATCH", body), delete: path => desktopRequest(path, "DELETE") });
  const shown = await fetchChatDetail(token, origin, chatId);
  expect(shown.record.readState?.unread).toBe(true);
  expect((await desktop.getDetail(chatId)).record.readState?.unread).toBe(true);
  const throughSeq = shown.messages.find(message => message.role === "assistant")!.seq;
  expect(shown.messages.find(message => message.seq === throughSeq)?.state).toBe("committed");
  const cursor = (await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })).at(-1)!.cursor;
  const response = await app.request(`/api/chats/events?cursor=${cursor}&readStateVersion=1&messageVersion=2&inputVersion=1&assistantTextVersion=1`, {
    headers: { Authorization: `Bearer ${token}`, accept: "text/event-stream" },
  });
  expect(response.status).toBe(200);
  reader = response.body!.getReader();
  await reader.read(); // attached, before the live mutation
  const replayEnd = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(replayEnd.split("data: ")[1]!.trim()).type).toBe("chat.replay.end");
  const saved = await updateChatReadState(token, origin, chatId, {
    type: "mark_read", throughSeq, baseVersion: shown.record.readState!.version,
  });
  expect(saved.readState).toMatchObject({ unread: false, markedUnread: false, readThroughSeq: throughSeq });
  const chunk = new TextDecoder().decode((await reader.read()).value);
  const frame = CanonicalChatTransportFrameSchema.parse(JSON.parse(chunk.split("data: ")[1]!.trim()));
  expect(frame).toMatchObject({ event: { chatId, eventType: "chat.user_state_updated" } });
  const observed = await desktop.getDetail(chatId);
  expect(observed.record.readState).toEqual(saved.readState);
  expect((await repository.get(owner, chatId))?.readState).toEqual(saved.readState);
  expect(observed.record.chat.revision).toBe(shown.record.chat.revision);
  expect(observed.record.chat.updatedAt).toBe(shown.record.chat.updatedAt);
});

it("a mobile read cannot clear a newer desktop manual reminder or acknowledge a different owner's chat", async () => {
  const shown = await fetchChatDetail(token, origin, chatId);
  const marked = await repository.updateReadState(owner, chatId, { type: "mark_unread" });
  const saved = await updateChatReadState(token, origin, chatId, {
    type: "mark_read", throughSeq: shown.record.readState!.latestIncomingSeq, baseVersion: shown.record.readState!.version,
  });
  expect(saved.readState).toEqual(marked.readState);
  expect(saved.readState?.markedUnread).toBe(true);
  await expect(updateChatReadState("other-token", origin, chatId, {
    type: "mark_read", throughSeq: shown.record.readState!.latestIncomingSeq, baseVersion: marked.readState!.version,
  })).rejects.toThrow("Could not update the chat.");
  expect((await repository.get(owner, chatId))?.readState).toEqual(marked.readState);
});
