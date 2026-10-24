import { afterEach, beforeEach, expect, it } from "vitest";
import { sql } from "kysely";
import type { CanonicalChatRunActivity } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const owner = { type: "personal" as const, ownerId: "retention_owner" };
const occurredAt = "2026-10-21T00:00:00.000Z";
let repository: ChatRepository;
let chatId: string;
let runId: string;
beforeEach(async () => {
  const database = await createTestPGlite();
  repository = new ChatRepository(database.dialect);
  await repository.bootstrap();
  const { snapshot } = createCanonicalChatFixture("accepted");
  chatId = snapshot.chat.id;
  runId = snapshot.runs[0]!.id;
  const record = await repository.create(owner, { id: chatId, title: "Retention", clientRequestId: "req_create" });
  const { executionRoot, executionRootFingerprint, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId, baseRevision: record.chat.revision, message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run });
  await repository.markRunRunning(owner, { chatId, runId, startedAt: occurredAt });
});
afterEach(async () => { await repository.kysely.destroy(); });

function progress(index: number): CanonicalChatRunActivity {
  return { id: `evt_${index}`, chatId, runId, occurredAt, sequence: index + 1, type: "run.status", status: "running" };
}
function terminal(): CanonicalChatRunActivity {
  return { id: "evt_terminal", chatId, runId, occurredAt, type: "run.status", status: "completed" };
}
function question(): CanonicalChatRunActivity {
  return { id: "evt_question", chatId, runId, occurredAt, sequence: 1, type: "input.requested", requestId: "question", title: "Name?",
    questions: [{ questionId: "name", header: "Name", question: "Your name?", allowOther: false, secret: false }] };
}
function claim(): CanonicalChatRunActivity {
  return { id: "evt_claim", chatId, runId, occurredAt, sequence: 2, type: "input.submitted", requestId: "question", clientRequestId: "req_answer" };
}
async function seed(events: CanonicalChatRunActivity[]) {
  await repository.kysely.insertInto("chat_run_events").values(events.map(event => ({
    id: event.id, chat_id: chatId, run_id: runId, run_seq: event.sequence!, occurred_at: occurredAt,
    event: sql`${JSON.stringify(event)}::jsonb`,
  }))).execute();
}
async function events() {
  return (await repository.kysely.selectFrom("chat_run_events").select("event").where("run_id", "=", runId).orderBy("run_seq").execute())
    .map(row => row.event as CanonicalChatRunActivity);
}

it("rolls ordinary activity without failing a busy run and broadcasts removed IDs", async () => {
  await seed(Array.from({ length: 500 }, (_, index) => progress(index)));
  await expect(repository.appendRunActivities(owner, chatId, runId, [progress(500)])).resolves.toBe(1);
  const retained = await events();
  expect(retained).toHaveLength(500);
  expect(retained[0]!.id).toBe("evt_1");
  expect(retained.at(-1)).toMatchObject({ id: "evt_500", sequence: 501 });
  const outbox = await repository.kysely.selectFrom("chat_outbox").select("payload").where("chat_id", "=", chatId).orderBy("cursor", "desc").executeTakeFirstOrThrow();
  expect(outbox.payload).toMatchObject({ streamContent: { removedActivityIds: ["evt_0"] } });
});

it.each([false, true])("keeps a pending input and its unconsumed claim through retention (submitted=%s)", async submitted => {
  const controls = submitted ? [question(), claim()] : [question()];
  await seed([...controls, ...Array.from({ length: 500 - controls.length }, (_, index) => progress(index + controls.length))]);
  await repository.appendRunActivities(owner, chatId, runId, [terminal()]);
  expect(await repository.getInputState(owner, { chatId, runId, requestId: "question" })).toMatchObject({
    request: { id: "evt_question" }, resolved: false, ...(submitted ? { submitted: { id: "evt_claim" } } : {}),
  });
  if (submitted) {
    await expect(repository.appendRunActivities(owner, chatId, runId, [{ ...claim(), id: "duplicate_claim" }])).rejects.toThrow();
  }
});

it("evicts a resolved input as one group without leaving a phantom pending question", async () => {
  const resolved: CanonicalChatRunActivity = { id: "evt_resolved", chatId, runId, occurredAt, sequence: 3, type: "input.resolved", requestId: "question", reason: "answered" };
  await seed([question(), claim(), resolved, ...Array.from({ length: 497 }, (_, index) => progress(index + 3))]);
  await repository.appendRunActivities(owner, chatId, runId, [terminal()]);
  expect((await events()).filter(event => "requestId" in event && event.requestId === "question")).toEqual([]);
  expect(await repository.getInputState(owner, { chatId, runId, requestId: "question" })).toEqual({ request: undefined, submitted: undefined, resolved: false });
});

it("binds a terminal after ordinary history fills retention and broadcasts evictions", async () => {
  await seed(Array.from({ length: 500 }, (_, index) => progress(index)));
  await expect(repository.bindTerminalSession(owner, { chatId, runId, sessionId: "retention-terminal", sessionCreatedAt: occurredAt })).resolves.toBe(true);
  const retained = await events();
  expect(retained).toHaveLength(500);
  expect(retained.at(-1)).toMatchObject({ type: "terminal.bound", sequence: 501 });
  const outbox = await repository.kysely.selectFrom("chat_outbox").select("payload").where("chat_id", "=", chatId).orderBy("cursor", "desc").executeTakeFirstOrThrow();
  expect(outbox.payload).toMatchObject({ streamContent: { removedActivityIds: ["evt_0"] } });
});

it("keeps event cursors increasing even when an entire resolved group is evicted", async () => {
  await seed([question(), claim(), ...Array.from({ length: 498 }, (_, index): CanonicalChatRunActivity => ({
    id: `resolved_${index}`, chatId, runId, occurredAt, sequence: index + 3,
    type: "input.resolved", requestId: "question", reason: "answered",
  }))]);
  await repository.appendRunActivities(owner, chatId, runId, [terminal()]);
  expect(await events()).toEqual([expect.objectContaining({ id: "evt_terminal", sequence: 501 })]);
});
