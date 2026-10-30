/**
 * Continues a bot's waiting task after the owner answers (spec 536). The
 * answer is admitted as the owner's next message in the bot's chat under a
 * request ID derived from the interaction, so a retried answer never runs
 * the bot twice. A chat that is busy queues it; a chat that changed between
 * the read and the admission is retried once.
 */
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { CanonicalChatOrchestrationError } from "../chat/orchestration-errors.js";
import type { ChatRepository } from "../chat/repository.js";
import type { RequestPrincipal } from "../request-principal.js";
import { BotInteractionError, type BotContinuation } from "./interactions.js";
import { MATRIX_BOT_SELECTION } from "./selection.js";
import { chatContextRequestHash } from "../chat/agent-context.js";

export type BotContinuationAdmitter = (principal: RequestPrincipal, continuation: BotContinuation) => Promise<void>;

export function createBotContinuationAdmitter(deps: {
  repository: Pick<ChatRepository, "get" | "findQueuedAdmission">;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn" | "enqueueQueuedTurn">;
}): BotContinuationAdmitter {
  return async (principal, continuation) => {
    const owner = { type: "personal" as const, ownerId: principal.userId };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = await deps.repository.get(owner, continuation.chatId);
      if (!record) throw new BotInteractionError("not_found");
      const input: CanonicalCreateChatTurnRequest = {
        clientRequestId: continuation.clientRequestId,
        baseRevision: record.chat.revision,
        parts: [{ type: "text", text: continuation.text }],
        selection: MATRIX_BOT_SELECTION,
        interactionMode: "default",
        permissionMode: "default",
      };
      // A retry may arrive after a busy answer was queued or already claimed.
      // Check that same owner/request/payload before the ordinary turn path,
      // which correctly refuses IDs belonging to queued admissions.
      if (await deps.repository.findQueuedAdmission(owner, continuation.chatId, continuation.clientRequestId,
        chatContextRequestHash(input))) return;
      try {
        await deps.orchestrator.admitTurn(principal, owner, continuation.chatId, input);
        return;
      } catch (error: unknown) {
        if (!(error instanceof CanonicalChatOrchestrationError)) throw error;
        if (error.safeError.code === "chat_busy") {
          try {
            // This is an automatic next turn, never a steer into the asking turn.
            await deps.orchestrator.enqueueQueuedTurn(principal, owner, continuation.chatId, input);
            return;
          } catch (enqueueError: unknown) {
            if (!(enqueueError instanceof CanonicalChatOrchestrationError)
              || !["chat_busy", "chat_conflict"].includes(enqueueError.safeError.code) || attempt > 0) throw enqueueError;
            // The asking turn can finish between these two admissions. Re-read
            // its revision and admit the same idempotent answer directly.
            continue;
          }
        }
        if (error.safeError.code !== "chat_conflict" || attempt > 0) throw error;
      }
    }
  };
}

export function botRoutineRequestId(fire:{fireId:string;attempts?:number}):string {
  return `req_routine_${fire.fireId}${(fire.attempts??1)>1?`_a${fire.attempts}`:""}`;
}

/** A fire is admitted once through the ordinary one-run-per-Chat path, including its durable queue. */
export function createBotRoutineCanonicalRunner(deps: Omit<Parameters<typeof createBotContinuationAdmitter>[0], "repository"> & {repository:Pick<ChatRepository,"get"|"findQueuedAdmission">}) {
  const admit=createBotContinuationAdmitter(deps);
  return async (routine:{ownerId:string;chatId:string;proposal:{prompt:string}},fire:{fireId:string;attempts?:number},signal:AbortSignal):Promise<{status:"accepted"|"cancelled"}> => {
    if (signal.aborted) return {status:"cancelled"};
    const clientRequestId=botRoutineRequestId(fire);
    const requestHash=chatContextRequestHash({parts:[{type:"text",text:routine.proposal.prompt}],selection:MATRIX_BOT_SELECTION,interactionMode:"default",permissionMode:"default"});
    if (await deps.repository.findQueuedAdmission({type:"personal",ownerId:routine.ownerId},routine.chatId,clientRequestId,requestHash)) return {status:"accepted"};
    await admit({userId:routine.ownerId,source:"configured-container"},{chatId:routine.chatId,clientRequestId,text:routine.proposal.prompt});
    // Accepted is not completion. The canonical adapter records the eventual fire outcome.
    return {status:"accepted"};
  };
}
