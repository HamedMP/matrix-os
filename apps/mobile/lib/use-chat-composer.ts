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
const MAX_PENDING_MESSAGES = 8;

const NEW_CHAT_DRAFT_KEY = chatDraftKey(null);

interface PendingMessage extends OptimisticUserMessage {
  /** `ComposerState.navigation` when it was sent. */
  navigation: number;
}

interface FailedSend {
  /** The chat it was sent in, or null for a new chat that was never bound. */
  chatId: string | null;
  /** The project a new chat was to be created in. */
  projectId: string | null;
  text: string;
  chatRequestId: string;
  turnRequestId: string;
  /** Its text has not gone back into a composer yet -- see `reconcile`. */
  held: boolean;
}

interface ComposerState {
  /** Bumped when the account or computer changes; callbacks from before it are ignored. */
  epoch: number;
  /** The account and computer this state belongs to, once known. */
  scope: string | null;
  shownChatId: string | null;
  /**
   * Bumped whenever the chat on screen changes. The new chat has no id of its
   * own, so this is what tells the new chat a message was sent from apart from
   * one the user has started since.
   */
  navigation: number;
  /** One draft per chat, so text typed in one chat is never offered to another. */
  drafts: ChatDrafts;
  pending: PendingMessage[];
  failed: FailedSend[];
}

function emptyComposerState(scope: string | null, shownChatId: string | null, epoch: number): ComposerState {
  return { epoch, scope, shownChatId, navigation: 0, drafts: {}, pending: [], failed: [] };
}

/** Brings the composer state in line with what is on screen. Returns `state` itself when nothing changed. */
function reconcile(
  state: ComposerState,
  on: { scope: string | null; activeChatId: string | null; detail: CanonicalChatDetailResponse | null; isSending: boolean },
): ComposerState {
  let next = state;
  if (on.scope !== null && next.scope !== on.scope) {
    // Drafts, pending messages and retry keys belong to one account's chats
    // on one computer; none of them carry over to another.
    next = next.scope === null
      ? { ...next, scope: on.scope }
      : emptyComposerState(on.scope, on.activeChatId, next.epoch + 1);
  }
  if (next.shownChatId !== on.activeChatId) {
    next = { ...next, shownChatId: on.activeChatId, navigation: next.navigation + 1 };
  }
  // Once the detail holds the server's copy of a message, that copy takes over.
  if (next.pending.some((message) => isOptimisticMessageDelivered(on.detail, message))) {
    next = { ...next, pending: next.pending.filter((message) => !isOptimisticMessageDelivered(on.detail, message)) };
  }
  // A failed new-chat send whose text could not go back at the time (the new
  // chat's composer held a different draft) returns once that composer is
  // free -- and not during a send, whose leftover text follows it into the
  // chat it creates.
  if (on.activeChatId === null && !on.isSending && !(next.drafts[NEW_CHAT_DRAFT_KEY] ?? "").trim()) {
    const held = next.failed.find((failed) => failed.held);
    if (held) {
      next = {
        ...next,
        drafts: writeChatDraft(next.drafts, NEW_CHAT_DRAFT_KEY, held.text),
        failed: next.failed.map((failed) => (failed === held ? { ...failed, held: false } : failed)),
      };
    }
  }
  return next;
}

interface ChatComposerOptions {
  /** The account and computer the chats belong to, or null while that is still loading. */
  scope: string | null;
  /** The chat on screen, or null for a draft chat not yet created. */
  activeChatId: string | null;
  detail: CanonicalChatDetailResponse | null;
  selection: CanonicalChatModelSelection | null;
  turnModes: { interactionMode: string; permissionMode: string } | null;
  /** Only applied when the send creates the chat. */
  projectId: string | null;
  /** Holds sends back, e.g. while the model selection is not final yet. */
  disabled?: boolean;
}

/**
 * The chat composer's draft and its optimistic send: the message is shown as
 * sent and the composer emptied straight away, instead of waiting for the
 * server to create the chat, admit the turn, and return a fresh detail.
 */
export function useChatComposer({
  scope,
  activeChatId,
  detail,
  selection,
  turnModes,
  projectId,
  disabled = false,
}: ChatComposerOptions) {
  const sendMessage = useSendChatMessage();
  const isSending = sendMessage.isPending;
  const [stored, setState] = useState(() => emptyComposerState(scope, activeChatId, 0));
  const state = reconcile(stored, { scope, activeChatId, detail, isSending });
  if (state !== stored) setState(state);

  const { epoch, navigation } = state;
  const draftKey = chatDraftKey(activeChatId);
  const draft = state.drafts[draftKey] ?? "";
  const setDraft = useCallback((text: string) => {
    setState((current) => {
      const drafts = writeChatDraft(current.drafts, draftKey, text);
      return drafts === current.drafts ? current : { ...current, drafts };
    });
  }, [draftKey]);

  const send = useCallback(() => {
    const trimmed = draft.trim();
    // One send at a time: the composer stays editable while a send is in
    // flight, and a second one would go out against the same stale revision
    // -- or, from a draft, create a second chat.
    if (disabled || !trimmed || !selection || !turnModes || isSending) return;
    // Reuse the idempotency keys of a failed send when the same text is
    // retried in the same chat -- if the first attempt's admission succeeded
    // server-side but its response was lost, retrying with fresh IDs would
    // create a second chat and run (and bill) the prompt again. A new chat
    // retried under a different project is not the same send: its creation
    // key would bring back the chat made in the old project.
    const retried = state.failed.find((failed) => (
      failed.chatId === activeChatId && failed.projectId === projectId && failed.text === trimmed
    ));
    const chatRequestId = retried?.chatRequestId ?? canonicalChatRequestId();
    const turnRequestId = retried?.turnRequestId ?? canonicalChatRequestId();
    const optimisticId = `optimistic-${turnRequestId}`;
    // The send's callbacks land later, possibly after a switch to another
    // account or computer has replaced this state.
    const update = (change: (current: ComposerState) => ComposerState) => {
      setState((current) => (current.epoch === epoch ? change(current) : current));
    };

    // A failed token fetch, computer resolution, chat creation, or turn
    // admission undoes both of these below, so the text is never lost.
    update((current) => ({
      ...current,
      pending: [
        ...current.pending.filter((message) => message.id !== optimisticId),
        { id: optimisticId, chatId: activeChatId, text: trimmed, turnRequestId, createdAt: Date.now(), navigation },
      ].slice(-MAX_PENDING_MESSAGES),
      drafts: writeChatDraft(current.drafts, draftKey, ""),
    }));
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
      onChatCreated: (chatId) => update((current) => ({
        ...current,
        pending: current.pending.map((message) => (message.id === optimisticId ? { ...message, chatId } : message)),
        // Text typed while this first send was in flight belongs to the chat
        // that now exists -- unless the user has moved on since, in which
        // case the new chat's composer holds a different draft.
        drafts: current.navigation === navigation
          ? moveChatDraft(current.drafts, draftKey, chatDraftKey(chatId))
          : current.drafts,
      })),
    }, {
      onSuccess: (admission) => update((current) => ({
        ...current,
        // This send is settled, even if it was a retry of a failure whose
        // text was still being held. So are this chat's other failures whose
        // text the user already has back: text repeated later is a new
        // message, not a retry.
        failed: current.failed.filter((failed) => (
          failed.turnRequestId !== turnRequestId && (failed.held || failed.chatId !== activeChatId)
        )),
        pending: current.pending.map((message) => (
          message.id === optimisticId ? { ...message, messageId: admission.message.id } : message
        )),
      })),
      onError: () => update((current) => {
        const typed = current.drafts[draftKey] ?? "";
        // The text goes back to the chat it was sent in -- which may no
        // longer be the one on screen -- ahead of anything typed there
        // meanwhile, so neither is lost. The exception is a new chat the user
        // has left and come back to: text in its composer now is a different
        // draft, so the failed text is held until that composer is free.
        const held = activeChatId === null && current.navigation !== navigation && typed.trim() !== "";
        return {
          ...current,
          pending: current.pending.filter((message) => message.id !== optimisticId),
          drafts: held
            ? current.drafts
            : writeChatDraft(current.drafts, draftKey, typed.trim() ? `${trimmed} ${typed}` : trimmed),
          failed: [
            ...current.failed.filter((failed) => failed.turnRequestId !== turnRequestId),
            { chatId: activeChatId, projectId, text: trimmed, chatRequestId, turnRequestId, held },
          ].slice(-MAX_FAILED_SENDS),
        };
      }),
    });
  }, [
    draft, draftKey, selection, turnModes, activeChatId, detail, projectId, disabled,
    sendMessage, isSending, state.failed, epoch, navigation,
  ]);

  // A message sent from the new chat is shown there only until the user moves
  // on: a new chat opened afterwards is a different one.
  const optimisticMessages = useMemo(() => state.pending.filter((message) => (
    message.chatId === activeChatId && (message.chatId !== null || message.navigation === navigation)
  )), [state.pending, activeChatId, navigation]);

  return {
    draft,
    setDraft,
    send,
    isSending,
    /** Sent messages to show in the chat on screen until the server's copies arrive, oldest first. */
    optimisticMessages,
  };
}
