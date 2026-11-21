import { createCanonicalChatAdmissionTracker, routineReceiptMessage } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse, CanonicalChatRecord, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalShellChatRequestError, isDefinitiveCanonicalChatRejection, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";

/** A committed receipt only appends history, so it cannot invalidate a prepared foreground send. */
export function advanceChatRecordForRoutineReceipts(
  record: CanonicalChatRecord,
  current: CanonicalChatDetailResponse | null,
): CanonicalChatRecord {
  const previous = record.chat;
  if (!current || current.record.chat.id !== previous.id) return record;
  const latest = current.record.chat;
  const added = latest.messageCount - previous.messageCount;
  if (added <= 0 || latest.revision !== previous.revision + added) return record;
  const appended = current.messages.slice(-added);
  const onlyReceipts = appended.length === added && appended.every((message, index) =>
    message.seq === previous.messageCount + index + 1 && routineReceiptMessage(message, previous.id));
  return onlyReceipts ? current.record : record;
}

export function admitShellChatTurn(options: {
  tracker: ReturnType<typeof createCanonicalChatAdmissionTracker>; identity: unknown;
  client: CanonicalShellChatClient; record: CanonicalChatRecord; input: CanonicalCreateChatTurnRequest; seed?: string;
  current: () => CanonicalChatDetailResponse | null; isCurrent: () => boolean; onAccepted: () => void;
  onRejected?: () => void; onPrepared: (requestId: string) => void; onConfirmed: (requestId: string) => void;
}) {
  const { clientRequestId: _id, baseRevision: _revision, ...semantic } = options.input;
  const attempt = options.tracker.prepare(options.identity, options.record.chat.id, semantic, options.seed);
  options.onPrepared(attempt.id);
  options.tracker.bind(attempt, options.record);
  return options.tracker.send(attempt, { post: request => options.client.admitTurn(options.record.chat.id, request),
    read: () => options.client.detail(options.record.chat.id), current: options.current,
    isCurrent: options.isCurrent, onRejected: options.onRejected, onAccepted: options.onAccepted, onConfirmed: () => options.onConfirmed(attempt.id),
    definitive: error => isDefinitiveCanonicalChatRejection(error)
      && !(error instanceof CanonicalShellChatRequestError && error.status === 408) });
}
