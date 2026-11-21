import type { CanonicalQueueChatTurnRequest } from "@matrix-os/contracts";
import type { createChatMentionRequestTracker } from "@matrix-os/ui";
import {
  isDefinitiveCanonicalChatRejection,
  type CanonicalShellChatClient,
} from "@/lib/canonical-chat-client";

/** Only proven non-delivery releases the saved Queue operation for a new Send. */
export async function queueShellChatTurn(
  client: CanonicalShellChatClient,
  requests: ReturnType<typeof createChatMentionRequestTracker>,
  chatId: string,
  input: CanonicalQueueChatTurnRequest,
) {
  try {
    return await client.queueTurn(chatId, input);
  } catch (error: unknown) {
    if (isDefinitiveCanonicalChatRejection(error)) {
      requests.accepted(chatId, input.clientRequestId);
    }
    throw error;
  }
}
