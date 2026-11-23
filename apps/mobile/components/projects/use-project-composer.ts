import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useMemo, useRef, useState } from "react";

import {
  MAX_MESSAGE_ATTACHMENTS,
  appendAttachments,
  sameAttachments,
  unreadableAttachments,
  unreadableNotice,
  type ChatAttachmentKind,
  type ComposerAttachment,
} from "@/lib/chat-attachments";
import { chatAttachmentSubmissionError } from "@/lib/chat-attachment-policy";
import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { NewChatDeliveryUnconfirmedError } from "@/lib/queries/new-chat-admission-recovery";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";
import { useMatrixAttachmentRetention } from "@/lib/use-matrix-attachment-retention";

// A failed send's request ids are kept until a send goes through; beyond this
// many the oldest is dropped.
const MAX_FAILED_SENDS = 8;

interface FailedSend {
  projectId: string;
  text: string;
  attachments: readonly ComposerAttachment[];
  chatRequestId: string;
  turnRequestId: string;
  /**
   * The model and modes it was sent with. The computer may have it already,
   * and answers a retry under its request ids only as the same request.
   */
  selection: CanonicalChatModelSelection;
  turnModes: { interactionMode: string; permissionMode: string };
}

interface ProjectComposerOptions {
  /** The project a sent message starts a chat in: its id, not its slug. */
  projectId: string | null;
  selection: CanonicalChatModelSelection | null;
  catalog: CanonicalProviderCatalog | null;
  turnModes: { interactionMode: string; permissionMode: string } | null;
  /**
   * The kinds of attachment the selected model reads. A message is not sent
   * while one of another kind is waiting. Left out, nothing is held back.
   */
  attachmentKinds?: readonly ChatAttachmentKind[];
  /** Owner, computer and project binding for Matrix file selections. */
  matrixAttachmentScope?: string;
  /** Holds sends back, as while there is no model to send to yet. */
  disabled?: boolean;
  /** Called once the new chat's first message is admitted, with the model and permission mode it was started with. */
  onChatStarted: (chatId: string, selection: CanonicalChatModelSelection, permissionMode: string) => void;
}

/**
 * The composer of a project screen: every message it sends starts a new chat
 * in the project, through the same request path as the chat screen. This
 * screen has no transcript to show a sent message in, so the text and the
 * attachments stay in the box until the server has them, and anything typed
 * meanwhile is kept. Nothing can be attached meanwhile: see `canAddAttachments`.
 */
export function useProjectComposer({
  projectId,
  selection,
  catalog,
  turnModes,
  attachmentKinds,
  matrixAttachmentScope,
  disabled = false,
  onChatStarted,
}: ProjectComposerOptions) {
  const sendMessage = useSendChatMessage();
  const isSending = sendMessage.isPending;
  const [draft, setDraftValue] = useState("");
  const [attachmentDraft, setAttachmentDraft] = useState<{
    scope: string | undefined;
    generation: number;
    items: readonly ComposerAttachment[];
  }>({ scope: matrixAttachmentScope, generation: 0, items: [] });
  const currentDraft = attachmentDraft.scope === matrixAttachmentScope ? attachmentDraft : {
    scope: matrixAttachmentScope,
    generation: attachmentDraft.generation + 1,
    items: attachmentDraft.items.filter(attachment => !attachment.matrixSource),
  };
  if (currentDraft !== attachmentDraft) setAttachmentDraft(currentDraft);
  const { items: attachments, generation: matrixGeneration } = currentDraft;
  const retainedMatrixUris = useMemo(() => attachments.filter((item) => item.matrixSource).map((item) => item.uri), [attachments]);
  useMatrixAttachmentRetention(retainedMatrixUris);
  const failedSends = useRef<FailedSend[]>([]);

  const text = draft.trim();
  const unreadable = attachmentKinds ? unreadableAttachments(attachments, attachmentKinds) : [];
  const attachmentNotice = unreadableNotice(unreadable) ?? chatAttachmentSubmissionError(catalog, selection, attachments);
  const canSend = !disabled && projectId !== null && (text !== "" || attachments.length > 0)
    // The computer would refuse the turn after the phone had uploaded the files.
    && attachmentNotice === null
    && selection !== null && turnModes !== null && !isSending;

  const clearSendError = () => {
    // Reset only a settled error. Resetting a pending mutation would detach its
    // observer and lose its retry bookkeeping while the person edits the draft.
    if (sendMessage.isError) sendMessage.reset();
  };
  const setDraft = (value: string) => {
    clearSendError();
    setDraftValue(value);
  };
  const addAttachments = (added: readonly ComposerAttachment[]) => {
    clearSendError();
    setAttachmentDraft(current => ({
      ...current,
      items: appendAttachments(current.items, current.generation === matrixGeneration ? added
        : added.filter(attachment => !attachment.matrixSource)),
    }));
  };
  const removeAttachment = (id: string) => {
    clearSendError();
    setAttachmentDraft(current => ({ ...current, items: current.items.filter(attachment => attachment.id !== id) }));
  };

  const send = () => {
    if (!canSend || projectId === null || selection === null || turnModes === null) return;
    // The same text sent again after a failure is the same message: had the
    // first attempt reached the server and only its answer been lost, new ids
    // would create a second chat and run the prompt again.
    const attempt = failedSends.current.find((failed) => (
      failed.projectId === projectId && failed.text === text && sameAttachments(failed.attachments, attachments)
    )) ?? {
      projectId, text, attachments, selection, turnModes,
      chatRequestId: canonicalChatRequestId(), turnRequestId: canonicalChatRequestId(),
    };

    sendMessage.mutate({
      chatId: null,
      baseRevision: 0,
      text,
      attachments,
      selection: attempt.selection,
      interactionMode: attempt.turnModes.interactionMode,
      permissionMode: attempt.turnModes.permissionMode,
      projectId,
      chatRequestId: attempt.chatRequestId,
      turnRequestId: attempt.turnRequestId,
      onChatCreated: (chatId) => {
        failedSends.current = [];
        // The box stays editable while the server answers, so it may hold
        // newer text and attachments by now. Only what was sent is cleared.
        setDraftValue((current) => (current.trim() === text ? "" : current));
        setAttachmentDraft(current => ({
          ...current,
          items: current.items.filter(waiting => !attachments.some(sent => sent.id === waiting.id)),
        }));
        onChatStarted(chatId, attempt.selection, attempt.turnModes.permissionMode);
      },
    }, {
      onError: () => {
        failedSends.current = [
          ...failedSends.current.filter((failed) => failed !== attempt),
          attempt,
        ].slice(-MAX_FAILED_SENDS);
      },
    });
  };

  return {
    draft,
    setDraft,
    attachments,
    addAttachments,
    removeAttachment,
    /** How many more can be added. What is being sent stays in the box, so it is counted. */
    attachmentRoom: Math.max(0, MAX_MESSAGE_ATTACHMENTS - attachments.length),
    /**
     * False while a message is on its way. When it is in, this screen is left
     * for the new chat, and what a photo library or file browser opened
     * meanwhile handed back would have no composer left to go to.
     */
    canAddAttachments: !isSending,
    /** The waiting attachments the selected model does not read. Nothing is sent while there are any. */
    unreadableAttachments: unreadable,
    attachmentNotice,
    sendError: sendMessage.isError
      ? sendMessage.error instanceof NewChatDeliveryUnconfirmedError
        ? "Could not confirm delivery. Retry to check again."
        : "Could not send message. Try again."
      : null,
    canSend,
    send,
    isSending,
  };
}
