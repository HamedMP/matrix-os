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
import { warningHaptic } from "@/lib/haptics";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { canonicalChatRequestId } from "@/lib/requests";

// A failed send's idempotency keys are kept until a send in its chat
// succeeds; beyond this many the oldest is dropped.
const MAX_FAILED_SENDS = 8;
// Sent messages still waiting for the server's copy. Only one send is in
// flight at a time, but an admitted message stays here until its chat's
// detail has caught up, which for a chat the user has left is on their return.
const MAX_PENDING_MESSAGES = 8;
// Messages shown as not sent. Beyond this many the oldest goes back to its
// chat's composer, so its words are never dropped.
const MAX_UNSENT_MESSAGES = 8;

const NEW_CHAT_DRAFT_KEY = chatDraftKey(null);
const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

interface PendingMessage extends OptimisticUserMessage {
  /** `ComposerState.navigation` when it was sent. */
  navigation: number;
  /** The project a new chat was to be created in. */
  projectId: string | null;
  /** The idempotency key of the chat a new chat's send creates. */
  chatRequestId: string;
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
  /** Messages sent from here that the server has not listed yet, including those that were not sent. */
  pending: PendingMessage[];
  /** Keys of failed sends whose text went back to a composer, or is waiting to. */
  failed: FailedSend[];
}

function emptyComposerState(scope: string | null, shownChatId: string | null, epoch: number): ComposerState {
  return {
    epoch, scope, shownChatId, navigation: 0, drafts: {}, attachments: {}, sentAttachments: {},
    sending: null, adopted: null, pending: [], failed: [],
  };
}

/**
 * How many of a composer's places are held for attachments that may come back
 * to it: those of the send on its way, and those of the chat's messages that
 * were not sent, which "Edit" puts back.
 */
function reservedAttachments(state: ComposerState, draftKey: string): number {
  const sending = state.sending?.draftKey === draftKey ? state.sending.attachments.length : 0;
  return state.pending.reduce((held, message) => (
    message.failed && chatDraftKey(message.chatId) === draftKey ? held + (message.attachments?.length ?? 0) : held
  ), sending);
}

/** Nothing is waiting in the new chat's composer, so a held send can go back into it. */
function newChatComposerIsFree(state: ComposerState): boolean {
  return !(state.drafts[NEW_CHAT_DRAFT_KEY] ?? "").trim()
    && readAttachmentDraft(state.attachments, NEW_CHAT_DRAFT_KEY).length === 0;
}

function failedSend(message: PendingMessage, held: boolean): FailedSend {
  return {
    chatId: message.chatId, projectId: message.projectId, text: message.text,
    attachments: message.attachments ?? NO_ATTACHMENTS, chatRequestId: message.chatRequestId,
    turnRequestId: message.turnRequestId, held,
  };
}

function rememberFailed(failed: readonly FailedSend[], message: PendingMessage, held: boolean): FailedSend[] {
  return [...failed.filter((record) => record.turnRequestId !== message.turnRequestId), failedSend(message, held)]
    .slice(-MAX_FAILED_SENDS);
}

/**
 * Takes a message that was not sent out of the chat and back into its chat's
 * composer, ahead of anything typed or added there since. Its keys are kept,
 * so sending it again unchanged is still the same send.
 */
function returnToComposer(state: ComposerState, message: PendingMessage): ComposerState {
  const draftKey = chatDraftKey(message.chatId);
  const typed = state.drafts[draftKey] ?? "";
  // The text is left as it is when only attachments were sent, so no stray
  // space is put in front of what was typed meanwhile.
  const text = message.text && typed.trim() ? `${message.text} ${typed}` : message.text || typed;
  const added = readAttachmentDraft(state.attachments, draftKey);
  return {
    ...state,
    pending: state.pending.filter((pending) => pending.id !== message.id),
    drafts: writeChatDraft(state.drafts, draftKey, text),
    // Room was held for these while they waited in the chat, so they fit.
    attachments: writeAttachmentDraft(state.attachments, draftKey, appendAttachments(message.attachments ?? NO_ATTACHMENTS, added)),
    failed: rememberFailed(state.failed, message, false),
  };
}

/** Adds a message on its way, dropping the oldest delivered ones beyond the limit. Messages not sent are kept. */
function withPending(pending: readonly PendingMessage[], added: PendingMessage): PendingMessage[] {
  const others = pending.filter((message) => message.id !== added.id);
  let excess = others.filter((message) => !message.failed).length + 1 - MAX_PENDING_MESSAGES;
  const kept = others.filter((message) => {
    if (excess <= 0 || message.failed) return true;
    excess -= 1;
    return false;
  });
  return [...kept, added];
}

/** Brings the composer state in line with what is on screen. Returns `state` itself when nothing changed. */
function reconcile(
  state: ComposerState,
  on: {
    scope: string | null;
    activeChatId: string | null;
    detail: CanonicalChatDetailResponse | null;
    isSending: boolean;
    projectId: string | null;
  },
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
  // Once the detail holds the server's copy of a message, that copy takes over
  // -- also for one shown as not sent whose answer was only lost.
  if (next.pending.some((message) => isOptimisticMessageDelivered(on.detail, message))) {
    next = { ...next, pending: next.pending.filter((message) => !isOptimisticMessageDelivered(on.detail, message)) };
  }
  // A new chat's message that was not sent is shown there only while that new
  // chat is on screen, in the project it was written for. Once the user has
  // moved on, it goes back the way a failed send's text always has: into the
  // next new chat's composer, as soon as that is free.
  const { navigation } = next;
  const orphaned = (message: PendingMessage) => Boolean(message.failed) && message.chatId === null
    && (message.navigation !== navigation || message.projectId !== on.projectId);
  if (next.pending.some(orphaned)) {
    next = {
      ...next,
      pending: next.pending.filter((message) => !orphaned(message)),
      failed: next.pending.filter(orphaned).reduce((failed, message) => rememberFailed(failed, message, true), next.failed),
    };
  }
  // A held send returns once the new chat's composer is free -- and not
  // during a send, whose leftover text follows it into the chat it creates --
  // and only when its attachments fit beside the places held for messages
  // there that were not sent, which "Edit" puts back.
  if (on.activeChatId === null && !on.isSending && newChatComposerIsFree(next)) {
    const room = MAX_MESSAGE_ATTACHMENTS - reservedAttachments(next, NEW_CHAT_DRAFT_KEY);
    const held = next.failed.find((failed) => failed.held && failed.attachments.length <= room);
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

/** What one send puts on its way: new from the composer, or a message that was not sent, sent again. */
interface Outgoing {
  text: string;
  attachments: readonly ComposerAttachment[];
  projectId: string | null;
  chatRequestId: string;
  turnRequestId: string;
}

/**
 * The chat composer's draft and its optimistic send: the message is shown as
 * sent and the composer emptied straight away, instead of waiting for the
 * server to create the chat, admit the turn, and return a fresh detail. A
 * message that fails to send stays where it was, marked as not sent, to be
 * sent again or taken back to the composer.
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
  const state = reconcile(stored, { scope, activeChatId, detail, isSending, projectId });
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

  // One send at a time: the composer stays editable while a send is in
  // flight, and a second one would go out against the same stale revision
  // -- or, from a draft, create a second chat.
  const sendHeldBack = disabled || !selection || !turnModes || isSending;

  const dispatch = useCallback((outgoing: Outgoing, fromComposer: boolean) => {
    if (!selection || !turnModes) return;
    const { text, attachments: sent, chatRequestId, turnRequestId } = outgoing;
    const optimisticId = `optimistic-${turnRequestId}`;
    // The send's callbacks land later, possibly after a switch to another
    // account or computer has replaced this state.
    const update = (change: (current: ComposerState) => ComposerState) => {
      setState((current) => (current.epoch === epoch ? change(current) : current));
    };

    update((current) => ({
      ...current,
      pending: withPending(current.pending, {
        id: optimisticId, chatId: activeChatId, text, attachments: sent, turnRequestId, chatRequestId,
        projectId: outgoing.projectId, createdAt: Date.now(), navigation,
      }),
      ...(fromComposer ? {
        drafts: writeChatDraft(current.drafts, draftKey, ""),
        attachments: writeAttachmentDraft(current.attachments, draftKey, NO_ATTACHMENTS),
      } : {}),
      sentAttachments: rememberSentAttachments(current.sentAttachments, sent),
      sending: { draftKey, attachments: sent },
    }));
    sendMessage.mutate({
      chatId: activeChatId,
      baseRevision: detail?.record.chat.revision ?? 0,
      text,
      attachments: sent,
      selection,
      interactionMode: turnModes.interactionMode,
      permissionMode: turnModes.permissionMode,
      projectId: outgoing.projectId,
      chatRequestId,
      turnRequestId,
      onChatCreated: (chatId) => update((current) => {
        // Still on the new chat this was sent from: text typed and attachments
        // added while this first send was in flight belong to the chat that
        // exists. A new chat the user has started since holds something else.
        // A message from this new chat that was not sent does not move with
        // them: the computer may have admitted it in a chat of its own, and
        // turn ids are told apart per chat. Once the screen moves on it goes
        // back to the next new chat's composer, keeping its creation key.
        const stayed = current.navigation === navigation;
        return {
          ...current,
          pending: current.pending.map((message) => (message.id === optimisticId ? { ...message, chatId } : message)),
          drafts: stayed ? moveChatDraft(current.drafts, draftKey, chatDraftKey(chatId)) : current.drafts,
          attachments: stayed
            ? moveAttachmentDraft(current.attachments, draftKey, chatDraftKey(chatId))
            : current.attachments,
          adopted: stayed ? { navigation, draftKey: chatDraftKey(chatId) } : current.adopted,
        };
      }),
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
      onError: () => {
        warningHaptic();
        // A failed token fetch, computer resolution, upload, chat creation,
        // or turn admission leaves the message where it was, marked as not
        // sent, so nothing that was sent is lost. Its keys stay with it.
        update((current) => {
          let next: ComposerState = {
            ...current,
            sending: null,
            pending: current.pending.map((message) => (
              message.id === optimisticId ? { ...message, failed: true } : message
            )),
          };
          const unsent = next.pending.filter((message) => message.failed);
          if (unsent.length > MAX_UNSENT_MESSAGES) next = returnToComposer(next, unsent[0]!);
          return next;
        });
      },
    });
  }, [activeChatId, detail, draftKey, epoch, navigation, selection, turnModes, sendMessage]);

  // The computer would refuse a turn whose attachments the model does not
  // read, after the phone had uploaded the files.
  const canSend = !sendHeldBack && (draft.trim().length > 0 || attachments.length > 0) && unreadable.length === 0;

  const send = useCallback(() => {
    if (!canSend) return;
    const trimmed = draft.trim();
    // Reuse the idempotency keys of a failed send whose text went back to the
    // composer when the same text is sent again in the same chat -- if the
    // first attempt's admission succeeded server-side but its response was
    // lost, retrying with fresh IDs would create a second chat and run (and
    // bill) the prompt again. A new chat retried under a different project is
    // not the same send: its creation key would bring back the chat made in
    // the old project. Nor is the same text with other attachments: the
    // computer would answer the retried request as the message it first
    // admitted.
    const retried = state.failed.find((failed) => (
      failed.chatId === activeChatId && failed.projectId === projectId && failed.text === trimmed
      && sameAttachments(failed.attachments, attachments)
    ));
    dispatch({
      text: trimmed,
      attachments,
      projectId,
      chatRequestId: retried?.chatRequestId ?? canonicalChatRequestId(),
      turnRequestId: retried?.turnRequestId ?? canonicalChatRequestId(),
    }, true);
  }, [canSend, draft, attachments, activeChatId, projectId, state.failed, dispatch]);

  /** A failed message's attachments that the selected model does not read: it cannot be sent again as it is. */
  const unreadableIn = useCallback((message: PendingMessage) => (
    attachmentKinds !== undefined
      && unreadableAttachments(message.attachments ?? NO_ATTACHMENTS, attachmentKinds).length > 0
  ), [attachmentKinds]);

  /** Sends a message that was not sent again, as the same send: same keys, same text and attachments. */
  const retrySend = useCallback((id: string) => {
    const message = state.pending.find((pending) => pending.id === id && pending.failed);
    if (!message || message.chatId !== activeChatId || sendHeldBack || unreadableIn(message)) return;
    dispatch({
      text: message.text,
      attachments: message.attachments ?? NO_ATTACHMENTS,
      projectId: message.projectId,
      chatRequestId: message.chatRequestId,
      turnRequestId: message.turnRequestId,
    }, false);
  }, [state.pending, activeChatId, sendHeldBack, unreadableIn, dispatch]);

  /** Takes a message that was not sent out of the chat and back into the composer. */
  const editUnsent = useCallback((id: string) => {
    setState((current) => {
      const message = current.pending.find((pending) => pending.id === id && pending.failed);
      return message ? returnToComposer(current, message) : current;
    });
  }, []);

  // A message sent from the new chat is shown there only until the user moves
  // on: a new chat opened afterwards is a different one.
  const optimisticMessages = useMemo(() => state.pending
    .filter((message) => (
      message.chatId === activeChatId && (message.chatId !== null || message.navigation === navigation)
    ))
    .map((message) => (
      message.failed ? { ...message, retryBlocked: sendHeldBack || unreadableIn(message) } : message
    )), [state.pending, activeChatId, navigation, sendHeldBack, unreadableIn]);

  return {
    draft,
    setDraft,
    /** The photos and files waiting to go with the next message from the chat on screen. */
    attachments,
    /** Adds to them, each once, up to the room there is. */
    addAttachments,
    removeAttachment,
    /** How many more can be added. Places are held for attachments still being sent, or not sent. */
    attachmentRoom,
    /** The waiting attachments the selected model does not read. Nothing is sent while there are any. */
    unreadableAttachments: unreadable,
    /** Where attachments sent from here still are on the phone, by their place on the computer. */
    sentAttachments: state.sentAttachments,
    /**
     * There is something to send and it can be sent now: nothing holds sends
     * back, no send is on its way, and the model reads what is attached.
     */
    canSend,
    send,
    isSending,
    /**
     * Sent messages to show in the chat on screen until the server's copies
     * arrive, oldest first. Those that were not sent are marked `failed`, with
     * `retryBlocked` when they cannot be sent again right now.
     */
    optimisticMessages,
    retrySend,
    editUnsent,
  };
}
