/**
 * Continues a bot's waiting task after the owner answers (spec 536). The
 * answer is admitted as the owner's next message in the bot's chat under a
 * request ID derived from the interaction, so a retried answer never runs
 * the bot twice. A chat that is busy queues it; a chat that changed between
 * the read and the admission is retried once.
 */
import type { CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { chatContextRequestHash } from "../chat/agent-context.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { CanonicalChatOrchestrationError } from "../chat/orchestration-errors.js";
import { ChatQueuedTurnCancelledError } from "../chat/errors.js";
import type { ChatRepository } from "../chat/repository.js";
import type { RequestPrincipal } from "../request-principal.js";
import { BotInteractionError, type BotContinuation } from "./interactions.js";
import { MATRIX_BOT_SELECTION } from "./selection.js";

export type BotContinuationAdmitter = (principal: RequestPrincipal, continuation: BotContinuation) => Promise<void | "cancelled">;

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
      // A previous process may have queued the answer before acknowledging it.
      // The canonical lookup verifies owner and exact request hash, including claimed entries.
      try {
        if (await deps.repository.findQueuedAdmission(owner, continuation.chatId, input.clientRequestId, chatContextRequestHash(input))) return;
      } catch (error: unknown) {
        if (error instanceof ChatQueuedTurnCancelledError) return "cancelled";
        throw error;
      }
      try {
        await deps.orchestrator.admitTurn(principal, owner, continuation.chatId, input);
        return;
      } catch (error: unknown) {
        if (!(error instanceof CanonicalChatOrchestrationError)) throw error;
        if (error.safeError.code === "chat_busy") {
          await deps.orchestrator.enqueueQueuedTurn(principal, owner, continuation.chatId, input);
          return;
        }
        if (error.safeError.code !== "chat_conflict" || attempt > 0) throw error;
      }
    }
  };
}
