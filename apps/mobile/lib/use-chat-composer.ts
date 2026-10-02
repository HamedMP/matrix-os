import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useCallback, useRef, useState } from "react";

import {
  isOptimisticMessageDelivered,
  latestMessageSeq,
  type OptimisticUserMessage,
} from "@/lib/canonical-chat-transcript";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { canonicalChatRequestId } from "@/lib/requests";

interface ChatComposerOptions {
  /** The chat on screen, or null for a draft chat not yet created. */
  activeChatId: string | null;
  detail: CanonicalChatDetailResponse | null;
  selection: CanonicalChatModelSelection | null;
  turnModes: { interactionMode: string; permissionMode: string } | null;
  /** Only applied when the send creates the chat. */
  projectId: string | null;
}

/**
 * The chat composer's draft and its optimistic send: the message is shown as
 * sent and the composer emptied straight away, instead of waiting for the
 * server to create the chat, admit the turn, and return a fresh detail.
 */
export function useChatComposer({ activeChatId, detail, selection, turnModes, projectId }: ChatComposerOptions) {
  const sendMessage = useSendChatMessage();
  const [draft, setDraft] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticUserMessage | null>(null);
  // Idempotency keys for the in-flight/most recent send attempt, keyed by its
  // exact drafted text -- see the comment in `send` below.
  const pendingSendRef = useRef<{ text: string; chatRequestId: string; turnRequestId: string } | null>(null);

  // Once the detail holds the server's copy, that copy takes over.
  const delivered = optimisticMessage !== null && isOptimisticMessageDelivered(detail, optimisticMessage);
  if (delivered) setOptimisticMessage(null);

  const send = useCallback(() => {
    const trimmed = draft.trim();
    // One send at a time: the composer stays editable while a send is in
    // flight, and a second one would go out against the same stale revision
    // -- or, from a draft, create a second chat.
    if (!trimmed || !selection || !turnModes || sendMessage.isPending) return;
    // Reuse the same idempotency keys across retries of this exact drafted
    // text -- if the first attempt's admission succeeded server-side but its
    // response was lost, retrying with fresh IDs would create a second chat
    // and run (and bill) the prompt again.
    if (pendingSendRef.current?.text !== trimmed) {
      pendingSendRef.current = {
        text: trimmed,
        chatRequestId: canonicalChatRequestId(),
        turnRequestId: canonicalChatRequestId(),
      };
    }
    const { chatRequestId, turnRequestId } = pendingSendRef.current;
    // A failed token fetch, computer resolution, chat creation, or turn
    // admission undoes both of these below, so the text is never lost.
    const optimisticId = `optimistic-${turnRequestId}`;
    setOptimisticMessage({
      id: optimisticId,
      chatId: activeChatId,
      text: trimmed,
      afterSeq: latestMessageSeq(detail),
      createdAt: Date.now(),
    });
    setDraft("");
    sendMessage.mutate({
      chatId: activeChatId,
      baseRevision: detail?.record.chat.revision ?? 0,
      text: trimmed,
      selection,
      interactionMode: turnModes.interactionMode,
      permissionMode: turnModes.permissionMode,
      projectId,
      chatRequestId,
      turnRequestId,
      onChatCreated: (chatId) => {
        setOptimisticMessage((current) => (current?.id === optimisticId ? { ...current, chatId } : current));
      },
    }, {
      onSuccess: (admission) => {
        if (pendingSendRef.current?.text === trimmed) pendingSendRef.current = null;
        setOptimisticMessage((current) => (
          current?.id === optimisticId ? { ...current, messageId: admission.message.id } : current
        ));
      },
      onError: () => {
        setOptimisticMessage((current) => (current?.id === optimisticId ? null : current));
        // Hand the text back for a retry, ahead of anything typed meanwhile.
        setDraft((current) => (current.trim() ? `${trimmed} ${current}` : trimmed));
      },
    });
  }, [draft, selection, turnModes, activeChatId, detail, projectId, sendMessage]);

  return {
    draft,
    setDraft,
    send,
    isSending: sendMessage.isPending,
    /** The just-sent message to show in the chat on screen, until the server's copy arrives. */
    optimisticMessage: optimisticMessage?.chatId === activeChatId && !delivered ? optimisticMessage : null,
  };
}
