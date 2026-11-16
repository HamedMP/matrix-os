import { RoutineActionIdSchema, RoutineActionSubmitSchema } from "@matrix-os/contracts";
import type { RoutineCliActionController } from "../bots/routine-action-controller.js";
import { CanonicalSubmitChatApprovalRequestSchema, type CanonicalChatApprovalSubmissionResponse,
  type CanonicalSubmitChatApprovalRequest } from "@matrix-os/contracts";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import type { ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";
import type { BrowserApprovalControl } from "./browser-approval-control.js";
import { CanonicalChatOrchestrationError, canonicalChatSafeError as safeError } from "./orchestration-errors.js";

export interface ApprovalProvenance { platformApprovalProof?: string; browserApprovalProof?: string; routineActionProof?: string }
export async function submitCanonicalApproval(options: {
  repository: Pick<ChatRepository, "getPendingApproval" | "getAdapterState">;
  active?: { owner: ChatOwner; chatId: string; instanceId: string; adapter: CanonicalChatProviderAdapter } | null;
  browserApprovals?: BrowserApprovalControl;
  routineActions?: Pick<RoutineCliActionController, "submitChat">;
}, owner: ChatOwner, chatId: string, runId: string, approvalId: string,
inputValue: CanonicalSubmitChatApprovalRequest, provenance?: ApprovalProvenance): Promise<CanonicalChatApprovalSubmissionResponse> {
  const input = CanonicalSubmitChatApprovalRequestSchema.parse(inputValue), active = options.active;
  if (!active || active.chatId !== chatId || active.owner.type !== owner.type || active.owner.ownerId !== owner.ownerId) {
    throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "This approval is no longer available."), 409);
  }
  try {
    if (RoutineActionIdSchema.safeParse(approvalId).success) {
      const routine = RoutineActionSubmitSchema.safeParse(input);
      if (!options.routineActions || !routine.success || !provenance?.routineActionProof || owner.type !== "personal")
        throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "This operation decision is unavailable."), 409);
      await options.routineActions.submitChat(owner.ownerId, chatId, runId, approvalId, routine.data, provenance.routineActionProof);
    } else if (input.browserApproval) {
      if (!options.browserApprovals || !provenance?.browserApprovalProof || owner.type !== "personal") {
        throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "This browser approval is unavailable."), 409);
      }
      await options.browserApprovals.submit({ ownerId: owner.ownerId, chatId, runId, approvalId, input, proof: provenance.browserApprovalProof });
    } else {
      if (!active.adapter.submitApproval) throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "This approval is no longer available."), 409);
      const pending = await options.repository.getPendingApproval(owner, { chatId, runId, approvalId });
      if (!pending || pending.browserApproval || !pending.allowedDecisions.includes(input.decision)) {
        throw new CanonicalChatOrchestrationError(safeError("capability_mismatch", "This approval decision is no longer available."), 409);
      }
      const state = await options.repository.getAdapterState(owner, { runId, driverKind: active.adapter.driverKind, instanceId: active.instanceId });
      await active.adapter.submitApproval({ owner, chatId, runId, approvalId, decision: input.decision, clientRequestId: input.clientRequestId,
        ...(input.actionDigest ? { actionDigest: input.actionDigest } : {}),
        ...(provenance?.platformApprovalProof ? { platformApprovalProof: provenance.platformApprovalProof } : {}),
        ...(state ? { state: active.adapter.parseState(state.state) } : {}) });
    }
  } catch (error: unknown) {
    if (error instanceof CanonicalChatOrchestrationError) throw error;
    console.warn("[chat/orchestrator] Approval callback unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new CanonicalChatOrchestrationError(safeError("run_unavailable", "The approval could not be submitted. Try again.", true, ["retry"]), 503);
  }
  return { approvalId, decision: input.decision, submission: "accepted" };
}
