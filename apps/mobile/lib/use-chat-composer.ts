import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useCallback, useMemo, useState } from "react";

import {
  isOptimisticMessageDelivered,
  type OptimisticUserMessage,
} from "@/lib/canonical-chat-transcript";
import { chatDraftKey, moveChatDraft, writeChatDraft, type ChatDrafts } from "@/lib/chat-drafts";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { canonicalChatRequestId } from "@/lib/requests";

// A failed send's idempotency keys are kept until a send in its chat
// succeeds; beyond this many the oldest is dropped.
const MAX_FAILED_SENDS = 8;
// Sent messages still waiting for the server's copy. Only one send is in
// flight at a time, but an admitted message stays here until its chat's
// detail has caught up, which for a chat the user has left is on their return.
const MAX_OPTIMISTIC_MESSAGES = 8;

interface FailedSend {
  /** The chat it was sent in, or null for a new chat that was never bound. */
  chatId: string | null;
  /** The project a new chat was to be created in. */
  projectId: string | null;
  text: string;
  chatRequestId: string;
  turnRequestId: string;
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
  // Each chat has its own draft, so text typed -- or handed back by a failed
  // send -- in one chat is never offered to another.
  const [drafts, setDrafts] = useState<ChatDrafts>({});
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);

  const draftKey = chatDraftKey(activeChatId);
  const draft = drafts[draftKey] ?? "";
  const setDraft = useCallback((text: string) => {
    setDrafts((current) => writeChatDraft(current, draftKey, text));
  }, [draftKey]);

  // Once the detail holds the server's copy of a message, that copy takes over.
  if (optimisticMessages.some((message) => isOptimisticMessageDelivered(detail, message))) {
    setOptimisticMessages((current) => current.filter((message) => !isOptimisticMessageDelivered(detail, message)));
  }
  const visibleOptimisticMessages = useMemo(() => optimisticMessages.filter((message) => (
    message.chatId === activeChatId && !isOptimisticMessageDelivered(detail, message)
  )), [optimisticMessages, activeChatId, detail]);

  const send = useCallback(() => {
    const trimmed = draft.trim();
    // One send at a time: the composer stays editable while a send is in
    // flight, and a second one would go out against the same stale revision
    // -- or, from a draft, create a second chat.
    if (!trimmed || !selection || !turnModes || sendMessage.isPending) return;
    // Reuse the idempotency keys of a failed send when the same text is
    // retried in the same chat -- if the first attempt's admission succeeded
    // server-side but its response was lost, retrying with fresh IDs would
    // create a second chat and run (and bill) the prompt again. A new chat
    // retried under a different project is not the same send: its creation
    // key would bring back the chat made in the old project.
    const retried = failedSends.find((failed) => (
      failed.chatId === activeChatId && failed.projectId === projectId && failed.text === trimmed
    ));
    const chatRequestId = retried?.chatRequestId ?? canonicalChatRequestId();
    const turnRequestId = retried?.turnRequestId ?? canonicalChatRequestId();
    // A failed token fetch, computer resolution, chat creation, or turn
    // admission undoes both of these below, so the text is never lost.
    const optimisticId = `optimistic-${turnRequestId}`;
    setOptimisticMessages((current) => [
      ...current.filter((message) => message.id !== optimisticId),
      { id: optimisticId, chatId: activeChatId, text: trimmed, turnRequestId, createdAt: Date.now() },
    ].slice(-MAX_OPTIMISTIC_MESSAGES));
    setDrafts((current) => writeChatDraft(current, draftKey, ""));
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
        setOptimisticMessages((current) => current.map((message) => (
          message.id === optimisticId ? { ...message, chatId } : message
        )));
        // Anything typed while this first send was in flight belongs to the
        // chat that now exists.
        setDrafts((current) => moveChatDraft(current, draftKey, chatDraftKey(chatId)));
      },
    }, {
      onSuccess: (admission) => {
        // This chat's earlier failures are settled too: text repeated later
        // is a new message, not a retry.
        setFailedSends((current) => current.filter((failed) => failed.chatId !== activeChatId));
        setOptimisticMessages((current) => current.map((message) => (
          message.id === optimisticId ? { ...message, messageId: admission.message.id } : message
        )));
      },
      onError: () => {
        setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticId));
        // Hand the text back to the chat it was sent in -- which may no
        // longer be the one on screen -- ahead of anything typed there
        // meanwhile, so neither is lost.
        setDrafts((current) => {
          const typed = current[draftKey] ?? "";
          return writeChatDraft(current, draftKey, typed.trim() ? `${trimmed} ${typed}` : trimmed);
        });
        setFailedSends((current) => [
          ...current.filter((failed) => failed.turnRequestId !== turnRequestId),
          { chatId: activeChatId, projectId, text: trimmed, chatRequestId, turnRequestId },
        ].slice(-MAX_FAILED_SENDS));
      },
    });
  }, [draft, draftKey, selection, turnModes, activeChatId, detail, projectId, sendMessage, failedSends]);

  return {
    draft,
    setDraft,
    send,
    isSending: sendMessage.isPending,
    /** Sent messages to show in the chat on screen until the server's copies arrive, oldest first. */
    optimisticMessages: visibleOptimisticMessages,
  };
}
