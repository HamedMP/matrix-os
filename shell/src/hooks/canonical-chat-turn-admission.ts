import { createCanonicalChatAdmissionTracker } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse, CanonicalChatRecord, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalShellChatRequestError, isDefinitiveCanonicalChatRejection, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";

export async function admitShellChatTurn(options: {
  tracker: ReturnType<typeof createCanonicalChatAdmissionTracker>; identity: unknown;
  client: CanonicalShellChatClient; record: CanonicalChatRecord; input: CanonicalCreateChatTurnRequest; seed?: string;
  current: () => CanonicalChatDetailResponse | null; isCurrent: () => boolean; onAccepted: () => void;
  onRejected?: () => void; onPrepared: (requestId: string) => void; onConfirmed: (requestId: string) => void;
}) {
  const { clientRequestId: _id, baseRevision: _revision, ...semantic } = options.input;
  const attempt = options.tracker.prepare(options.identity, options.record.chat.id, semantic, options.seed);
  const finishPreparation = options.tracker.beginPreparation(attempt);
  let post;
  try {
    options.onPrepared(attempt.id);
    post = await options.client.prepareTurnAdmission?.(options.record.chat.id, { ...options.input, clientRequestId: attempt.id });
    if (!options.isCurrent()) throw new Error('Chat context changed');
    options.tracker.bind(attempt, options.record, options.current()?.record);
    finishPreparation();
  } catch (error: unknown) {
    if (finishPreparation(true)) options.onRejected?.();
    throw error;
  }
  return options.tracker.send(attempt, { post: post ?? (request => options.client.admitTurn(options.record.chat.id, request)),
    read: () => options.client.detail(options.record.chat.id), current: options.current,
    isCurrent: options.isCurrent, onRejected: options.onRejected, onAccepted: options.onAccepted, onConfirmed: () => options.onConfirmed(attempt.id),
    definitive: error => isDefinitiveCanonicalChatRejection(error)
      && !(error instanceof CanonicalShellChatRequestError && error.status === 408) });
}
