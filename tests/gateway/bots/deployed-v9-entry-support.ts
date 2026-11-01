import { BotEntryError } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestration-errors.js";

/** Keep thread refusal distinct from ordinary Chat capability/conflict errors. */
export function retainedThreadEntryFailure(error: unknown) {
  if (error instanceof BotEntryError) {
    return { accepted: false as const, errorType: "BotEntryError" as const, code: error.code };
  }
  if (error instanceof CanonicalChatOrchestrationError) {
    return { accepted: false as const, errorType: "CanonicalChatOrchestrationError" as const,
      code: error.safeError.code, status: error.status };
  }
  throw error;
}
