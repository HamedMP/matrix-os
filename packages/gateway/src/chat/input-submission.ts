import { buildCanonicalChatInputAnswer, CanonicalChatRunActivitySchema, type CanonicalChatRunActivity, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
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
  const rows = await db.selectFrom("chat_run_events")
    .innerJoin("chat_runs", "chat_runs.id", "chat_run_events.run_id")
    .innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .select("chat_run_events.event")
    .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
    .where("chats.id", "=", input.chatId).where("chat_runs.id", "=", input.runId)
    .orderBy("chat_run_events.run_seq").limit(500).execute();
  let request: Request | undefined;
  let submitted: Extract<CanonicalChatRunActivity, { type: "input.submitted" }> | undefined;
  let resolved = false;
  for (const row of rows) {
    const parsed = CanonicalChatRunActivitySchema.safeParse(row.event);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (!("requestId" in event) || event.requestId !== input.requestId) continue;
    if (event.type === "input.requested") request = event;
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
  const rows = await db.selectFrom("chat_run_events").select("event").where("run_id", "=", runId).orderBy("run_seq").limit(500).execute();
  const pending = new Map<string, "input" | "approval">();
  for (const row of rows) {
    const parsed = CanonicalChatRunActivitySchema.safeParse(row.event);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type === "input.requested") pending.set(`input:${event.requestId}`, "input");
    if (event.type === "input.resolved") pending.delete(`input:${event.requestId}`);
    if (event.type === "approval.requested") pending.set(`approval:${event.approvalId}`, "approval");
    if (event.type === "approval.resolved") pending.delete(`approval:${event.approvalId}`);
  }
  if ([...pending.values()].includes("approval")) return { runStatus: "waiting_for_approval" as const, attention: "approval_required" as const };
  if (pending.size) return { runStatus: "waiting_for_input" as const, attention: "input_required" as const };
  return { runStatus: "running" as const, attention: "none" as const };
}
