import { afterEach, beforeEach, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { canonicalChatApprovals, canonicalChatInputs, type CanonicalChatRunActivity } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

const owner = { type: "personal" as const, ownerId: "user_pending_controls" };
let repository: ChatRepository;
let chatId: string;
let runId: string;

beforeEach(async () => {
  const database = await KyselyPGlite.create();
  repository = new ChatRepository(database.dialect);
  await repository.bootstrap();
  const { snapshot } = createCanonicalChatFixture("accepted");
  chatId = snapshot.chat.id;
  runId = snapshot.runs[0]!.id;
  const record = await repository.create(owner, { id: chatId, title: "Pending controls", clientRequestId: "req_create" });
  const { executionRoot, executionRootFingerprint, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, {
    chatId, baseRevision: record.chat.revision, message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run,
  });
  await repository.markRunRunning(owner, { chatId, runId, startedAt: new Date().toISOString() });
});

afterEach(async () => { await repository.kysely.destroy(); });

async function insertEvents(events: CanonicalChatRunActivity[]): Promise<void> {
  await repository.kysely.insertInto("chat_run_events").values(events.map((event, index) => ({
    id: event.id,
    chat_id: chatId,
    run_id: runId,
    run_seq: index + 1,
    event: sql`${JSON.stringify(event)}::jsonb`,
    occurred_at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
  }))).execute();
}

function statusEvents(): CanonicalChatRunActivity[] {
  return Array.from({ length: 500 }, (_, index) => ({
    id: `evt_status_${index}`, chatId, runId, occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 2)).toISOString(),
    type: "run.status" as const, status: "running" as const,
  }));
}

it("keeps pending input and approval actionable after 500 newer activities", async () => {
  const events: CanonicalChatRunActivity[] = [
    { id: "evt_input", chatId, runId, occurredAt: "2026-10-01T00:00:00.000Z", type: "input.requested", requestId: "input_old", title: "Answer", asynchronous: true,
      questions: [{ questionId: "answer", header: "Answer", question: "Continue?", allowOther: false, secret: false }] },
    { id: "evt_approval", chatId, runId, occurredAt: "2026-10-01T00:00:01.000Z", type: "approval.requested", approvalId: "approval_old", title: "Approve", risk: "low", allowedDecisions: ["approve", "decline"] },
    ...statusEvents(),
  ];
  await insertEvents(events);
  const detail = await repository.getDetailPage(owner, chatId, { limit: 50 });
  expect(detail?.activities).toHaveLength(500);
  expect(canonicalChatInputs(detail!).find((item) => item.requestId === "input_old")?.pending).toBe(true);
  expect(canonicalChatApprovals(detail!).find((item) => item.approvalId === "approval_old")?.pending).toBe(true);
  expect(detail?.activities.at(-1)?.id).toBe("evt_status_499");
});

it("does not resurrect an answered input after it leaves the detail window", async () => {
  await insertEvents([
    { id: "evt_input", chatId, runId, occurredAt: "2026-10-01T00:00:00.000Z", type: "input.requested", requestId: "input_old", title: "Answer", asynchronous: true,
      questions: [{ questionId: "answer", header: "Answer", question: "Continue?", allowOther: false, secret: false }] },
    { id: "evt_submitted", chatId, runId, occurredAt: "2026-10-01T00:00:01.000Z", type: "input.submitted", requestId: "input_old", clientRequestId: "req_answer" },
    ...statusEvents(),
  ]);
  const detail = await repository.getDetailPage(owner, chatId, { limit: 50 });
  expect(canonicalChatInputs(detail!).find((item) => item.requestId === "input_old")?.pending).not.toBe(true);
});

it("shows a reopened input but not an approval with a durable outcome", async () => {
  const request = { chatId, runId, occurredAt: "2026-10-01T00:00:00.000Z", type: "input.requested" as const,
    requestId: "input_retry", title: "Retry", asynchronous: true,
    questions: [{ questionId: "answer", header: "Answer", question: "Continue?", allowOther: false, secret: false }] };
  await insertEvents([
    { ...request, id: "evt_original" },
    { id: "evt_submission", chatId, runId, occurredAt: "2026-10-01T00:00:01.000Z", type: "input.submitted", requestId: "input_retry", clientRequestId: "req_answer" },
    { ...request, id: "activity_input_retry_evt_submission", occurredAt: "2026-10-01T00:00:02.000Z" },
    { id: "evt_approval", chatId, runId, occurredAt: "2026-10-01T00:00:03.000Z", type: "approval.requested", approvalId: "approval_done", title: "Approve", risk: "low", allowedDecisions: ["approve", "decline"] },
    ...statusEvents(),
  ]);
  await repository.kysely.insertInto("chat_approval_outcomes").values({
    chat_id: chatId, run_id: runId, approval_id: "approval_done", decision: "approve",
    activity_id: "evt_approval", resolved_at: new Date().toISOString(),
  }).execute();
  const detail = await repository.getDetailPage(owner, chatId, { limit: 50 });
  expect(canonicalChatInputs(detail!).find((item) => item.requestId === "input_retry")?.pending).toBe(true);
  expect(canonicalChatApprovals(detail!).find((item) => item.approvalId === "approval_done")?.pending).not.toBe(true);
});
