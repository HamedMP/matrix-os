import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useCallback, useState } from "react";

import {
  isOptimisticMessageDelivered,
  type OptimisticUserMessage,
} from "@/lib/canonical-chat-transcript";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { canonicalChatRequestId } from "@/lib/requests";

// A failed send is kept until it is retried successfully; beyond this many
// the oldest is dropped.
const MAX_FAILED_SENDS = 8;

interface FailedSend {
  /** The chat it was sent in, or null for a draft whose chat was never bound. */
  chatId: string | null;
  text: string;
  chatRequestId: string;
  turnRequestId: string;
  /** Whether its text has gone back into the composer yet. */
  restored: boolean;
}

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
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);

  // Once the detail holds the server's copy, that copy takes over.
  const delivered = optimisticMessage !== null && isOptimisticMessageDelivered(detail, optimisticMessage);
  if (delivered) setOptimisticMessage(null);

  // A failed send's text goes back into the composer of the chat it was sent
  // in -- at once if that chat is still on screen, otherwise when the user
  // returns to it. The composer is shared by every chat, so restoring it
  // wherever the user happens to be would offer the text to the wrong one.
  const returning = failedSends.filter((failed) => !failed.restored && failed.chatId === activeChatId);
  if (returning.length > 0) {
    const returningIds = new Set(returning.map((failed) => failed.turnRequestId));
    setFailedSends((current) => current.map((failed) => (
      returningIds.has(failed.turnRequestId) ? { ...failed, restored: true } : failed
    )));
    const text = returning.map((failed) => failed.text).join(" ");
    // Ahead of anything typed meanwhile, so neither is lost.
    setDraft((current) => (current.trim() ? `${text} ${current}` : text));
  }

  const send = useCallback(() => {
    const trimmed = draft.trim();
    // One send at a time: the composer stays editable while a send is in
    // flight, and a second one would go out against the same stale revision
    // -- or, from a draft, create a second chat.
    if (!trimmed || !selection || !turnModes || sendMessage.isPending) return;
    // Reuse the idempotency keys of a failed send when the same text is
    // retried in the same chat -- if the first attempt's admission succeeded
    // server-side but its response was lost, retrying with fresh IDs would
    // create a second chat and run (and bill) the prompt again.
    const retried = failedSends.find((failed) => failed.chatId === activeChatId && failed.text === trimmed);
    const chatRequestId = retried?.chatRequestId ?? canonicalChatRequestId();
    const turnRequestId = retried?.turnRequestId ?? canonicalChatRequestId();
    // A failed token fetch, computer resolution, chat creation, or turn
    // admission undoes both of these below, so the text is never lost.
    const optimisticId = `optimistic-${turnRequestId}`;
    setOptimisticMessage({
      id: optimisticId,
      chatId: activeChatId,
      text: trimmed,
      turnRequestId,
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
        // This send is settled, and so is any earlier failure in this chat
        // whose text the user already got back: a later message that happens
        // to repeat that text is a new message, not a retry.
        setFailedSends((current) => current.filter((failed) => (
          failed.turnRequestId !== turnRequestId && !(failed.restored && failed.chatId === activeChatId)
        )));
        setOptimisticMessage((current) => (
          current?.id === optimisticId ? { ...current, messageId: admission.message.id } : current
        ));
      },
      onError: () => {
        setOptimisticMessage((current) => (current?.id === optimisticId ? null : current));
        setFailedSends((current) => [
          ...current.filter((failed) => failed.turnRequestId !== turnRequestId),
          { chatId: activeChatId, text: trimmed, chatRequestId, turnRequestId, restored: false },
        ].slice(-MAX_FAILED_SENDS));
      },
    });
  }, [draft, selection, turnModes, activeChatId, detail, projectId, sendMessage, failedSends]);

  return {
    draft,
    setDraft,
    send,
    isSending: sendMessage.isPending,
    /** The just-sent message to show in the chat on screen, until the server's copy arrives. */
    optimisticMessage: optimisticMessage?.chatId === activeChatId && !delivered ? optimisticMessage : null,
  };
}
