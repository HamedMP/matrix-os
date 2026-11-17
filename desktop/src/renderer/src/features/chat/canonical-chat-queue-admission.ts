import type { CanonicalChatDetailResponse, CanonicalQueueChatTurnRequest } from "@matrix-os/contracts";

/** A lost HTTP reply is not a rejection. Only this request's durable row can
 * acknowledge its draft; identical text from a different send cannot do so.
 */
export function hasQueuedChatAdmission(
  detail: CanonicalChatDetailResponse | null,
  chatId: string,
  request: CanonicalQueueChatTurnRequest,
): boolean {
  if (detail?.record.chat.id !== chatId) return false;
  const sameParts = (parts: readonly unknown[]) => JSON.stringify(parts) === JSON.stringify(request.parts);
  if (detail.queuedTurns?.some(turn => turn.chatId === chatId
    && turn.clientRequestId === request.clientRequestId && sameParts(turn.parts))) return true;
  // The FIFO may already have promoted the request while the reply was lost.
  const turn = detail.turns.find(turn => turn.chatId === chatId && turn.clientRequestId === request.clientRequestId);
  return Boolean(turn && detail.messages.some(message => message.id === turn.inputMessageId
    && message.chatId === chatId && message.turnId === turn.id && message.role === "user" && message.state === "committed" && sameParts(message.parts))
    && detail.runs.some(run => run.chatId === chatId && run.turnId === turn.id && run.attempt === 1));
}
