import type { CanonicalChatDetailResponse, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useCallback, useMemo, useState } from "react";

import {
  isOptimisticMessageDelivered,
  type OptimisticUserMessage,
} from "@/lib/canonical-chat-transcript";
import {
  MAX_MESSAGE_ATTACHMENTS,
  appendAttachments,
  moveAttachmentDraft,
  readAttachmentDraft,
  rememberSentAttachments,
  sameAttachments,
  unreadableAttachments,
  writeAttachmentDraft,
  type ChatAttachmentDrafts,
  type ChatAttachmentKind,
  type ComposerAttachment,
  type SentAttachmentUris,
} from "@/lib/chat-attachments";
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
const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

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
  /** What was sent with the text. It goes back to the composer with it. */
  attachments: readonly ComposerAttachment[];
  chatRequestId: string;
  turnRequestId: string;
  /** Its text and attachments have not gone back into a composer yet -- see `reconcile`. */
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
  /** The photos and files waiting in each chat's composer, kept apart like the drafts. */
  attachments: ChatAttachmentDrafts;
  /** Where attachments sent from here still are on the phone. */
  sentAttachments: SentAttachmentUris;
  /**
   * The attachments of the send on its way, and the composer they return to
   * if it fails. Room is kept for them there until the send is settled, so
   * that nothing added meanwhile is pushed out when they come back.
   */
  sending: { draftKey: string; attachments: readonly ComposerAttachment[] } | null;
  /**
   * The chat that the new chat of `navigation` became. What was being chosen
   * for that new chat when it was created goes to this chat.
   */
  adopted: { navigation: number; draftKey: string } | null;
  pending: PendingMessage[];
  failed: FailedSend[];
}

function emptyComposerState(scope: string | null, shownChatId: string | null, epoch: number): ComposerState {
  return {
    epoch, scope, shownChatId, navigation: 0, drafts: {}, attachments: {}, sentAttachments: {},
    sending: null, adopted: null, pending: [], failed: [],
  };
}

/** How many of a composer's places are held for attachments that may come back to it. */
function reservedAttachments(state: ComposerState, draftKey: string): number {
  return state.sending?.draftKey === draftKey ? state.sending.attachments.length : 0;
}

/** Nothing is waiting in the new chat's composer, so a held send can go back into it. */
function newChatComposerIsFree(state: ComposerState): boolean {
  return !(state.drafts[NEW_CHAT_DRAFT_KEY] ?? "").trim()
    && readAttachmentDraft(state.attachments, NEW_CHAT_DRAFT_KEY).length === 0;
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
  if (on.activeChatId === null && !on.isSending && newChatComposerIsFree(next)) {
    const held = next.failed.find((failed) => failed.held);
    if (held) {
      next = {
        ...next,
        drafts: writeChatDraft(next.drafts, NEW_CHAT_DRAFT_KEY, held.text),
        attachments: writeAttachmentDraft(next.attachments, NEW_CHAT_DRAFT_KEY, held.attachments),
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
  /**
   * The kinds of attachment the selected model reads. A message is not sent
   * while one of another kind is waiting. Left out, nothing is held back.
   */
  attachmentKinds?: readonly ChatAttachmentKind[];
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
  attachmentKinds,
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

  const attachments = readAttachmentDraft(state.attachments, draftKey);
  const attachmentRoom = Math.max(0, MAX_MESSAGE_ATTACHMENTS - reservedAttachments(state, draftKey) - attachments.length);
  const unreadable = useMemo(() => (
    attachmentKinds ? unreadableAttachments(attachments, attachmentKinds) : NO_ATTACHMENTS
  ), [attachments, attachmentKinds]);
  const addAttachments = useCallback((added: readonly ComposerAttachment[]) => {
    if (added.length === 0) return;
    setState((current) => {
      // What was chosen belongs to the account and computer that were there
      // when choosing began, and to the chat it was chosen for -- which, for
      // a new chat created while the choosing went on, is the chat it became.
      if (current.epoch !== epoch) return current;
      const key = draftKey === NEW_CHAT_DRAFT_KEY && current.adopted?.navigation === navigation
        ? current.adopted.draftKey
        : draftKey;
      const waiting = readAttachmentDraft(current.attachments, key);
      const limit = MAX_MESSAGE_ATTACHMENTS - reservedAttachments(current, key);
      const next = appendAttachments(waiting, added, limit);
      return next.length === waiting.length
        ? current
        : { ...current, attachments: writeAttachmentDraft(current.attachments, key, next) };
    });
  }, [draftKey, epoch, navigation]);
  const removeAttachment = useCallback((id: string) => {
    setState((current) => {
      const waiting = readAttachmentDraft(current.attachments, draftKey);
      if (!waiting.some((attachment) => attachment.id === id)) return current;
      return {
        ...current,
        attachments: writeAttachmentDraft(current.attachments, draftKey, waiting.filter((attachment) => attachment.id !== id)),
      };
    });
  }, [draftKey]);

  const send = useCallback(() => {
    const trimmed = draft.trim();
    // One send at a time: the composer stays editable while a send is in
    // flight, and a second one would go out against the same stale revision
    // -- or, from a draft, create a second chat.
    if (disabled || (!trimmed && attachments.length === 0) || !selection || !turnModes || isSending) return;
    // The computer would refuse the turn after the phone had uploaded the files.
    if (unreadable.length > 0) return;
    // Reuse the idempotency keys of a failed send when the same text is
    // retried in the same chat -- if the first attempt's admission succeeded
    // server-side but its response was lost, retrying with fresh IDs would
    // create a second chat and run (and bill) the prompt again. A new chat
    // retried under a different project is not the same send: its creation
    // key would bring back the chat made in the old project. Nor is the same
    // text with other attachments: the computer would answer the retried
    // request as the message it first admitted.
    const retried = state.failed.find((failed) => (
      failed.chatId === activeChatId && failed.projectId === projectId && failed.text === trimmed
      && sameAttachments(failed.attachments, attachments)
    ));
    const chatRequestId = retried?.chatRequestId ?? canonicalChatRequestId();
    const turnRequestId = retried?.turnRequestId ?? canonicalChatRequestId();
    const optimisticId = `optimistic-${turnRequestId}`;
    // The send's callbacks land later, possibly after a switch to another
    // account or computer has replaced this state.
    const update = (change: (current: ComposerState) => ComposerState) => {
      setState((current) => (current.epoch === epoch ? change(current) : current));
    };

    // A failed token fetch, computer resolution, upload, chat creation, or
    // turn admission undoes these below, so nothing that was sent is lost.
    update((current) => ({
      ...current,
      pending: [
        ...current.pending.filter((message) => message.id !== optimisticId),
        {
          id: optimisticId, chatId: activeChatId, text: trimmed, attachments, turnRequestId,
          createdAt: Date.now(), navigation,
        },
      ].slice(-MAX_PENDING_MESSAGES),
      drafts: writeChatDraft(current.drafts, draftKey, ""),
      attachments: writeAttachmentDraft(current.attachments, draftKey, NO_ATTACHMENTS),
      sentAttachments: rememberSentAttachments(current.sentAttachments, attachments),
      sending: { draftKey, attachments },
    }));
    sendMessage.mutate({
      chatId: activeChatId,
      baseRevision: detail?.record.chat.revision ?? 0,
      text: trimmed,
      attachments,
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
        // that now exists, and so do attachments added meanwhile -- unless
        // the user has moved on since, in which case the new chat's composer
        // holds a different draft.
        drafts: current.navigation === navigation
          ? moveChatDraft(current.drafts, draftKey, chatDraftKey(chatId))
          : current.drafts,
        attachments: current.navigation === navigation
          ? moveAttachmentDraft(current.attachments, draftKey, chatDraftKey(chatId))
          : current.attachments,
        adopted: current.navigation === navigation
          ? { navigation, draftKey: chatDraftKey(chatId) }
          : current.adopted,
      })),
    }, {
      onSuccess: (admission) => update((current) => ({
        ...current,
        sending: null,
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
        const added = readAttachmentDraft(current.attachments, draftKey);
        // The text goes back to the chat it was sent in -- which may no
        // longer be the one on screen -- ahead of anything typed there
        // meanwhile, so neither is lost; the attachments go back the same
        // way. The exception is a new chat the user has left and come back
        // to: what is in its composer now is a different draft, so the failed
        // send is held until that composer is free.
        const held = activeChatId === null && current.navigation !== navigation
          && (typed.trim() !== "" || added.length > 0);
        // The text is left as it is when only attachments were sent, so no
        // stray space is put in front of what was typed meanwhile.
        const restoredText = trimmed && typed.trim() ? `${trimmed} ${typed}` : trimmed || typed;
        return {
          ...current,
          sending: null,
          pending: current.pending.filter((message) => message.id !== optimisticId),
          drafts: held ? current.drafts : writeChatDraft(current.drafts, draftKey, restoredText),
          attachments: held
            ? current.attachments
            : writeAttachmentDraft(current.attachments, draftKey, appendAttachments(attachments, added)),
          failed: [
            ...current.failed.filter((failed) => failed.turnRequestId !== turnRequestId),
            { chatId: activeChatId, projectId, text: trimmed, attachments, chatRequestId, turnRequestId, held },
          ].slice(-MAX_FAILED_SENDS),
        };
      }),
    });
  }, [
    draft, draftKey, attachments, unreadable, selection, turnModes, activeChatId, detail, projectId, disabled,
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
    /** The photos and files waiting to go with the next message from the chat on screen. */
    attachments,
    /** Adds to them, each once, up to the room there is. */
    addAttachments,
    removeAttachment,
    /** How many more can be added. Places are held for attachments still being sent. */
    attachmentRoom,
    /** The waiting attachments the selected model does not read. Nothing is sent while there are any. */
    unreadableAttachments: unreadable,
    /** Where attachments sent from here still are on the phone, by their place on the computer. */
    sentAttachments: state.sentAttachments,
    send,
    isSending,
    /** Sent messages to show in the chat on screen until the server's copies arrive, oldest first. */
    optimisticMessages,
  };
}
