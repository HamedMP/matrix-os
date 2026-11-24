import { useCallback, useState } from "react";
import { canonicalTranscriptWithPendingSend, nextPendingCanonicalSend, type PendingCanonicalSend, type PendingCanonicalTurn } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

/**
 * The message being sent, shown from the moment it is sent, also before a new
 * Chat exists. Each selection starts a draft session; a draft send shows only
 * in its own. Display only: the shared projection drops it once the server's
 * turn is in the detail, and the send clears it by token when it settles.
 */
export function useCanonicalPendingSend(identity: unknown) {
  const [pendingSend, setPendingSend] = useState<PendingCanonicalSend | null>(null);
  const [draftSession, setDraftSession] = useState(0);

  /** A new selection: a draft send from the previous one stops showing. */
  const startDraftSession = useCallback((session: number) => {
    setDraftSession(session);
    setPendingSend(pending => pending?.sourceChatId === undefined ? null : pending);
  }, []);

  /** Shows this send's message unless its draft session has already ended. */
  const show = useCallback((send: Omit<PendingCanonicalSend, "turn">, turn: Omit<PendingCanonicalTurn, "createdAt">, sessionEnded: () => boolean) => {
    setPendingSend(previous => send.sourceChatId === undefined && sessionEnded() ? previous : nextPendingCanonicalSend(previous, send, turn));
  }, []);

  /** Clears only this send's message, never a newer one. */
  const clear = useCallback((token: object) => {
    setPendingSend(pending => pending?.token === token ? null : pending);
  }, []);

  const visible = pendingSend?.identity === identity ? pendingSend : null;
  const transcript = (detail: CanonicalChatDetailResponse | null, activeChatId: string | null) => canonicalTranscriptWithPendingSend({
    detail, pending: visible, activeChatId: activeChatId ?? undefined, draftSession,
  });
  return { pendingTurn: visible?.turn ?? null, startDraftSession, show, clear, transcript };
}
