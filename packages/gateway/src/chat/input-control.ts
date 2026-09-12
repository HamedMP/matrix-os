import { createHash } from "node:crypto";
import { CanonicalSubmitChatInputRequestSchema, type CanonicalChatInputSubmissionResponse, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import type { ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import { CanonicalChatOrchestrationError } from "./orchestrator.js";
import { ChatRunNotActiveError, ChatConflictError } from "./errors.js";
import { ChatInputAnswerValidationError, validateChatInputAnswer } from "./input-submission.js";
type Active = { owner: ChatOwner; chatId: string; instanceId: string; adapter: CanonicalChatProviderAdapter; controller: AbortController };
function unavailable() {
  return new CanonicalChatOrchestrationError({ code: "capability_mismatch", safeMessage: "This input request is no longer available.", retryable: false, recoveryActions: [] }, 409);
}
export async function submitCanonicalInput(options: {
  repository: Pick<ChatRepository, "getInputState" | "getAdapterState" | "appendRunActivities">;
  active?: Active; owner: ChatOwner; chatId: string; runId: string; requestId: string; input: CanonicalSubmitChatInputRequest;
}): Promise<CanonicalChatInputSubmissionResponse> {
  const { repository, active, owner, chatId, runId, requestId } = options;
  const input = CanonicalSubmitChatInputRequestSchema.parse(options.input);
  const existing = await repository.getInputState(owner, { chatId, runId, requestId });
  if (existing.submitted) {
    if (existing.submitted.clientRequestId === input.clientRequestId) return { requestId, submission: "already_submitted" };
    throw unavailable();
  }
  if (!existing.request || existing.resolved || !active || active.controller.signal.aborted
    || active.chatId !== chatId || active.owner.type !== owner.type || active.owner.ownerId !== owner.ownerId
    || !active.adapter.submitInput) throw unavailable();
  try { validateChatInputAnswer(existing.request, input); } catch (error: unknown) {
    if (error instanceof ChatInputAnswerValidationError) throw unavailable();
    throw error;
  }
  const saved = await repository.getAdapterState(owner, { runId, driverKind: active.adapter.driverKind, instanceId: active.instanceId });
  const state = saved ? active.adapter.parseState(saved.state) : undefined;
  // Claim identity belongs to the pending request, not to the browser retry id.
  const identity = createHash("sha256").update(`${runId}\0${requestId}`).digest("hex");
  let claimed: number;
  try {
    claimed = await repository.appendRunActivities(owner, chatId, runId, [{
      id: `activity_input_${identity}`, chatId, runId, occurredAt: new Date().toISOString(),
      type: "input.submitted", requestId, clientRequestId: input.clientRequestId,
    }]);
  } catch (error) {
    if (error instanceof ChatRunNotActiveError || error instanceof ChatConflictError) throw unavailable();
    throw error;
  }
  if (!claimed) {
    const claim = await repository.getInputState(owner, { chatId, runId, requestId });
    if (claim.submitted?.clientRequestId === input.clientRequestId) return { requestId, submission: "already_submitted" };
    throw unavailable();
  }
  if (active.controller.signal.aborted) throw unavailable();
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.adapter.submitInput({ owner, chatId, runId, requestId, ...input, ...(state === undefined ? {} : { state }) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Input delivery timed out")), 10_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error: unknown) {
    console.warn("[chat/input] Provider input callback failed:", error instanceof Error ? error.name : "UnknownError");
    // Delivery is ambiguous: preserve the durable claim and never replay native work.
    throw new CanonicalChatOrchestrationError({ code: "run_unavailable", safeMessage: "The answer could not be confirmed. Check the conversation before continuing.", retryable: false, recoveryActions: [] }, 503);
  }
  try {
    const delivered = await repository.getInputState(owner, { chatId, runId, requestId });
    if (delivered.resolved) return { requestId, submission: "accepted" };
    await repository.appendRunActivities(owner, chatId, runId, [{
      id: `activity_input_resolved_${identity}`, chatId, runId, occurredAt: new Date().toISOString(), type: "input.resolved", requestId, reason: "answered",
    }]);
  } catch (error) {
    if (!(error instanceof ChatRunNotActiveError)) throw error;
    // The same native run can finish before the control response; its terminal state fences the card.
  }
  return { requestId, submission: "accepted" };
}
