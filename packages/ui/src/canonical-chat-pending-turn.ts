import type { CanonicalChatDetailResponse, CanonicalChatMessage, CanonicalChatMessagePart } from "@matrix-os/contracts";

/** A message the person sent whose turn the server has not confirmed yet. */
export interface PendingCanonicalTurn {
  requestId: string;
  chatId: string;
  parts: CanonicalChatMessagePart[];
  createdAt: string;
}

/**
 * The detail as it should be shown while a send is in flight: the sent message
 * appears at once as the newest user turn instead of after the admission round
 * trip. Display only; never sent or stored. It disappears as soon as the
 * server's turn for the same request is in the detail, and the caller drops it
 * when the send ends, whether accepted or rejected (the composer keeps the
 * draft until acceptance, so a rejected send loses nothing).
 */
export function withPendingCanonicalTurn(
  detail: CanonicalChatDetailResponse,
  pending: PendingCanonicalTurn | null | undefined,
): CanonicalChatDetailResponse {
  if (!pending || detail.record.chat.id !== pending.chatId) return detail;
  if (detail.turns.some(turn => turn.clientRequestId === pending.requestId)) return detail;
  const baseMessageSeq = detail.messages.reduce((max, message) => Math.max(max, message.seq), 0);
  const message = pendingCanonicalTurnMessage(pending, baseMessageSeq + 1);
  return {
    ...detail,
    messages: [...detail.messages, message],
    turns: [...detail.turns, {
      id: message.turnId!, chatId: pending.chatId, clientRequestId: pending.requestId, baseMessageSeq,
      inputMessageId: message.id, status: "accepted", createdAt: pending.createdAt, updatedAt: pending.createdAt,
    }],
  };
}

/**
 * The pending message on its own, for a new Chat whose detail does not exist
 * yet (the Chat may not even be created). Display only, like the above.
 */
export function pendingCanonicalTurnMessage(pending: PendingCanonicalTurn, seq = 1): CanonicalChatMessage {
  const suffix = pending.requestId.replace(/^req_/, "");
  return {
    id: `msg_pending_${suffix}`, chatId: pending.chatId, seq, role: "user", state: "committed",
    purpose: "ai_request", turnId: `cturn_pending_${suffix}`, parts: pending.parts, createdAt: pending.createdAt,
  };
}
