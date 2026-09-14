import { afterEach, beforeEach, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { CanonicalChatContentSchema } from "@matrix-os/contracts";
import { applyCanonicalChatContent } from "../../packages/ui/src/canonical-chat-content.js";

let repository: ChatRepository;
const owner = { type: "personal" as const, ownerId: "owner_stream" };
beforeEach(async () => {
  const db = await KyselyPGlite.create();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
});
afterEach(async () => { await repository.kysely.destroy(); });

it("persists exact text deltas atomically and publishes terminal state without requiring a detail read", async () => {
  const { snapshot } = createCanonicalChatFixture("running");
  const id = snapshot.chat.id;
  await repository.create(owner, { id, clientRequestId: "req_content", title: "Content" });
  const initial = (await repository.getDetailPage(owner, id, { limit: 200 }))!;
  const turn = { ...snapshot.turns[0]!, status: "accepted" as const };
  const { startedAt: _startedAt, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, {
    chatId: id, baseRevision: 0, message: snapshot.messages[0]!, turn,
    run: { ...run, status: "accepted", capabilitySnapshot: { ...run.capabilitySnapshot, steering: "same_run" } },
  });
  await repository.markRunRunning(owner, { chatId: id, runId: run.id, startedAt: snapshot.chat.createdAt });
  await repository.appendRunActivities(owner, id, run.id, [{ id: "activity_running", chatId: id,
    runId: run.id, type: "run.status", status: "running", occurredAt: snapshot.chat.createdAt }]);
  await repository.enqueueQueuedTurn(owner, {
    chatId: id, baseRevision: (await repository.get(owner, id))!.chat.revision,
    queuedTurnId: "qturn_content", clientRequestId: "req_queue_content",
    parts: [{ type: "text", text: "do this later" }], driverKind: run.driverKind,
    selection: run.selection, interactionMode: run.interactionMode, permissionMode: run.permissionMode,
    capabilitySnapshot: run.capabilitySnapshot, createdAt: snapshot.chat.createdAt,
  });
  await repository.beginSteer(owner, { chatId: id, runId: run.id, expectedTurnId: turn.id,
    steerId: "steer_content", messageId: "msg_steer_content", clientRequestId: "req_steer_content",
    parts: [{ type: "text", text: "focus here" }], createdAt: snapshot.chat.createdAt });
  await repository.acceptSteer(owner, { chatId: id, runId: run.id,
    clientRequestId: "req_steer_content", acceptedAt: snapshot.chat.createdAt });
  for (const delta of ["hello", " world"]) {
    await repository.appendAssistantDelta(owner, {
      chatId: id, runId: run.id, messageId: "msg_content", delta, createdAt: snapshot.chat.createdAt,
    });
  }
  const events = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
  const content = events.filter((event) => event.eventType === "run.message")
    .map((event) => CanonicalChatContentSchema.parse(event.payload.streamContent));
  expect(content.map((c) => c.messageDelta?.offset)).toEqual([0, 5]);
  expect(content.map((c) => c.messageDelta?.message.parts)).toEqual([
    [{ type: "text", text: "hello" }], [{ type: "text", text: " world" }],
  ]);
  await repository.finishRun(owner, { chatId: id, runId: run.id, outcome: "completed", completedAt: snapshot.chat.createdAt });
  const completed = (await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })).at(-1)!;
  const state = CanonicalChatContentSchema.parse(completed.payload.streamContent);
  expect(state.record.activeRun).toBeUndefined();
  expect(state.runs?.[0]?.status).toBe("completed");
  expect(state.messages?.find((m) => m.id === "msg_content")?.state).toBe("committed");
  let streamed = initial;
  for (const { payload, ...event } of await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })) {
    const next = applyCanonicalChatContent(streamed, { type: "chat.content", event,
      content: CanonicalChatContentSchema.parse(payload.streamContent) });
    expect(next).not.toBeNull();
    streamed = next!;
  }
  expect(streamed).toEqual(await repository.getDetailPage(owner, id, { limit: 200 }));
  await repository.hardDelete(owner, { chatId: id, clientRequestId: "req_delete_content" });
  const afterDelete = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
  expect(afterDelete.at(-1)?.eventType).toBe("chat.deleted");
  expect(JSON.stringify(afterDelete)).not.toContain("streamContent");
  expect(JSON.stringify(afterDelete)).not.toContain("hello");
});

it("signals recovery with the current checkpoint when the bounded replay cannot cover the backlog", async () => {
  await repository.create(owner, { id: "chat_backlog", clientRequestId: "req_backlog", title: "Backlog" });
  const first = (await repository.replayOutbox(owner, { afterCursor: 0, limit: 1 }))[0]!;
  await repository.kysely.insertInto("chat_outbox").values(Array.from({ length: 150 }, (_, i) => ({
    owner_type: owner.type, owner_id: owner.ownerId,
    chat_id: "chat_backlog", revision: i + 1, event_type: "run.message", payload: {},
  }))).execute();
  const window = await repository.replayOutboxWindow(owner, { afterCursor: first.cursor, limit: 100 });
  expect(window.gap).toBe(true);
  expect(window.nextCursor).toBe(first.cursor + 150);
});
