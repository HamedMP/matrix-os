import type { CanonicalChatDetailResponse, CanonicalChatRunSteeringResponse } from "@matrix-os/contracts";

/** A committed receipt adds a message even when a newer stream snapshot won the race. */
export function applyChatSteeringReceipt(
  current: CanonicalChatDetailResponse | null,
  submitted: CanonicalChatDetailResponse,
  response: CanonicalChatRunSteeringResponse,
  queuedTurnId?: string,
): CanonicalChatDetailResponse | null {
  if (!current || current.record.chat.id !== submitted.record.chat.id) return current;
  const messages = current.messages.some(message => message.id === response.message.id)
    ? current.messages
    : [...current.messages, response.message].sort((left, right) => left.seq - right.seq);
  // Only the untouched submission snapshot can use the known begin/accept revision pair.
  // A concurrent snapshot owns all newer metadata and will reconcile through the stream.
  const record = response.steering === "accepted" && current.record.chat.revision === submitted.record.chat.revision
    ? { ...current.record, chat: { ...current.record.chat,
      revision: current.record.chat.revision + 2,
      messageCount: Math.max(current.record.chat.messageCount, response.message.seq),
      updatedAt: response.message.createdAt,
    } } : current.record;
  return { ...current, record, messages,
    ...(queuedTurnId ? { queuedTurns: (current.queuedTurns ?? []).filter(turn => turn.id !== queuedTurnId) } : {}),
  };
}
