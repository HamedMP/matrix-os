import { buildCanonicalChatInputAnswer, CanonicalChatRunActivitySchema, type CanonicalChatRunActivity, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";
import { ChatConflictError } from "./errors.js";
export class ChatInputAnswerValidationError extends Error {}

type Request = Extract<CanonicalChatRunActivity, { type: "input.requested" }>;
export function validateChatInputAnswer(request: Pick<Request, "questions" | "expiresAt">, answer: CanonicalSubmitChatInputRequest): void {
  if (!request.questions?.length || (request.expiresAt && Date.parse(request.expiresAt) <= Date.now())) throw new ChatInputAnswerValidationError("Input unavailable");
  const values = answer.structuredAnswers;
  if (!values) {
    if (request.questions.length !== 1 || request.questions[0].options?.length || !answer.answer?.trim()) throw new ChatInputAnswerValidationError("Structured answers required");
    if (!buildCanonicalChatInputAnswer(request, { [request.questions[0].questionId]: [answer.answer] })) throw new ChatInputAnswerValidationError("Invalid answers");
    return;
  }
  if (!buildCanonicalChatInputAnswer(request, values)) throw new ChatInputAnswerValidationError("Invalid answers");
}
export async function getChatInputState(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner, input: { chatId: string; runId: string; requestId: string }) {
  const latestByType = db.selectFrom("chat_run_events")
    .innerJoin("chat_runs", "chat_runs.id", "chat_run_events.run_id")
    .innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .select([
      "chat_run_events.event",
      "chat_run_events.run_seq",
      sql<number>`row_number() over (
        partition by chat_run_events.event ->> 'type'
        order by chat_run_events.run_seq desc
      )`.as("type_rank"),
    ])
    .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
    .where("chats.id", "=", input.chatId).where("chat_runs.id", "=", input.runId)
    .where(sql<string>`chat_run_events.event ->> 'requestId'`, "=", input.requestId)
    .where(sql<string>`chat_run_events.event ->> 'type'`, "in", ["input.requested", "input.submitted", "input.resolved"])
    .as("latest_by_type");
  const rows = await db.selectFrom(latestByType)
    .select(["event", "run_seq"])
    .where("type_rank", "=", 1)
    .orderBy("run_seq")
    .limit(3)
    .execute();
  let request: Request | undefined;
  let submitted: Extract<CanonicalChatRunActivity, { type: "input.submitted" }> | undefined;
  let resolved = false;
  for (const row of rows) {
    const parsed = CanonicalChatRunActivitySchema.safeParse(row.event);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (!("requestId" in event) || event.requestId !== input.requestId) continue;
    if (event.type === "input.requested") {
      if (submitted && event.id === `activity_input_retry_${submitted.id}`) submitted = undefined;
      request = event;
    }
    if (event.type === "input.submitted") submitted = event;
    if (event.type === "input.resolved") resolved = true;
  }
  return { request, submitted, resolved };
}
/** Runs while the Chat row lock is held, before atomically inserting the claim. */
export async function assertInputClaim(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, owner: ChatOwner, activity: CanonicalChatRunActivity): Promise<void> {
  if (activity.type !== "input.submitted") return;
  const state = await getChatInputState(db, owner, activity);
  if (!state.request || state.resolved || state.submitted || (state.request.expiresAt && Date.parse(state.request.expiresAt) <= Date.now())) {
    throw new ChatConflictError(activity.chatId, 0);
  }
}

/** A late response to one request must not clear a newer pending question. */
export async function pendingInputTransition(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, runId: string) {
  const state = await db.selectNoFrom([
    sql<boolean>`EXISTS (
      SELECT 1 FROM chat_run_events requested
      WHERE requested.run_id = ${runId} AND (requested.event ->> 'type') = 'approval.requested'
        AND NOT EXISTS (SELECT 1 FROM chat_approval_outcomes outcomes
          WHERE outcomes.run_id = requested.run_id
            AND outcomes.approval_id = (requested.event ->> 'approvalId'))
        AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved
          WHERE resolved.run_id = requested.run_id AND (resolved.event ->> 'type') = 'approval.resolved'
            AND (resolved.event ->> 'approvalId') = (requested.event ->> 'approvalId'))
    )`.as("approval"),
    sql<boolean>`EXISTS (
      SELECT 1 FROM chat_run_events requested
      WHERE requested.run_id = ${runId} AND (requested.event ->> 'type') = 'input.requested'
        AND (requested.event ->> 'asynchronous') IS DISTINCT FROM 'true'
        AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved
          WHERE resolved.run_id = requested.run_id AND (resolved.event ->> 'type') = 'input.resolved'
            AND (resolved.event ->> 'requestId') = (requested.event ->> 'requestId'))
    )`.as("input"),
    sql<boolean>`EXISTS (
      SELECT 1 FROM chat_run_events requested
      WHERE requested.run_id = ${runId} AND (requested.event ->> 'type') = 'input.requested'
        AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved
          WHERE resolved.run_id = requested.run_id AND (resolved.event ->> 'type') = 'input.resolved'
            AND (resolved.event ->> 'requestId') = (requested.event ->> 'requestId'))
    )`.as("anyInput"),
  ]).executeTakeFirstOrThrow();
  if (state.approval) return { runStatus: "waiting_for_approval" as const, attention: "approval_required" as const };
  if (state.input) return { runStatus: "waiting_for_input" as const, attention: "input_required" as const };
  if (state.anyInput) return { runStatus: "running" as const, attention: "input_required" as const };
  return { runStatus: "running" as const, attention: "none" as const };
}
