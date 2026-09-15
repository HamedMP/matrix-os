import { afterEach, beforeEach, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { canonicalChatInputs } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

const owner = { type: "personal" as const, ownerId: "user_retry" };
let repository: ChatRepository;
let chatId: string, runId: string;
const requestId = "input_retry";
beforeEach(async () => {
  const database = await KyselyPGlite.create();
  repository = new ChatRepository(database.dialect);
  await repository.bootstrap();
  const { snapshot } = createCanonicalChatFixture("accepted");
  chatId = snapshot.chat.id; runId = snapshot.runs[0]!.id;
  const record = await repository.create(owner, { id: chatId, title: "Retry input", clientRequestId: "req_create" });
  const { executionRoot, executionRootFingerprint, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId, baseRevision: record.chat.revision, message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run });
  await repository.markRunRunning(owner, { chatId, runId, startedAt: new Date().toISOString() });
  await repository.appendRunActivities(owner, chatId, runId, [{
    id: "evt_question", chatId, runId, occurredAt: new Date().toISOString(), type: "input.requested", requestId, title: "Name", asynchronous: true,
    questions: [{ questionId: "name", header: "Name", question: "Your name?", allowOther: false, secret: false }],
  }, { id: "evt_claim", chatId, runId, occurredAt: new Date().toISOString(), type: "input.submitted", requestId, clientRequestId: "req_answer" }]);
});
afterEach(async () => { await repository.kysely.destroy(); });
it("reopens only the exact failed claim and preserves append-only history for retry", async () => {
  const reopened = await Promise.all([1, 2].map(() => repository.reopenInputSubmission(owner, { chatId, runId, requestId, submissionId: "evt_claim" })));
  expect(reopened.filter(Boolean)).toHaveLength(1);
  expect(await repository.getInputState(owner, { chatId, runId, requestId })).toMatchObject({ submitted: undefined, resolved: false, request: { id: "activity_input_retry_evt_claim" } });
  const rows = await repository.kysely.selectFrom("chat_run_events").select("event").where("run_id", "=", runId).orderBy("run_seq").execute();
  const views = canonicalChatInputs({ activities: rows.map(row => row.event), runs: [{ id: runId, status: "running" }], turns: [], messages: [] } as never);
  expect(views).toHaveLength(1); expect(views[0]).toMatchObject({ pending: true, submitted: false });
  await repository.appendRunActivities(owner, chatId, runId, [{ id: "evt_retry_claim", chatId, runId, occurredAt: new Date().toISOString(), type: "input.submitted", requestId, clientRequestId: "req_answer" }]);
  expect(await repository.reopenInputSubmission(owner, { chatId, runId, requestId, submissionId: "evt_claim" })).toBe(false);
  expect((await repository.getInputState(owner, { chatId, runId, requestId })).submitted?.id).toBe("evt_retry_claim");
  expect(rows.some(row => (row.event as { id: string }).id === "evt_claim")).toBe(true);
});
it("never reopens a resolved question or a different owner's claim", async () => {
  expect(await repository.reopenInputSubmission({ type: "personal", ownerId: "other" }, { chatId, runId, requestId, submissionId: "evt_claim" })).toBe(false);
  await repository.appendRunActivities(owner, chatId, runId, [{ id: "evt_resolved", chatId, runId, occurredAt: new Date().toISOString(), type: "input.resolved", requestId, reason: "expired" }]);
  expect(await repository.reopenInputSubmission(owner, { chatId, runId, requestId, submissionId: "evt_claim" })).toBe(false);
  expect((await repository.getInputState(owner, { chatId, runId, requestId })).resolved).toBe(true);
});
