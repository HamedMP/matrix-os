import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useRef, useState } from "react";

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
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";

// A failed send's request ids are kept until a send goes through; beyond this
// many the oldest is dropped.
const MAX_FAILED_SENDS = 8;

interface FailedSend {
  projectId: string;
  text: string;
  attachments: readonly ComposerAttachment[];
  chatRequestId: string;
  turnRequestId: string;
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
  /** Holds sends back, as while there is no model to send to yet. */
  disabled?: boolean;
  /** Called once the new chat's first message is admitted, with the model it was started with. */
  onChatStarted: (chatId: string, selection: CanonicalChatModelSelection) => void;
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
  disabled = false,
  onChatStarted,
}: ProjectComposerOptions) {
  const sendMessage = useSendChatMessage();
  const isSending = sendMessage.isPending;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const failedSends = useRef<FailedSend[]>([]);

  const text = draft.trim();
  const unreadable = attachmentKinds ? unreadableAttachments(attachments, attachmentKinds) : [];
  const attachmentNotice = unreadableNotice(unreadable) ?? chatAttachmentSubmissionError(catalog, selection, attachments);
  const canSend = !disabled && projectId !== null && (text !== "" || attachments.length > 0)
    // The computer would refuse the turn after the phone had uploaded the files.
    && attachmentNotice === null
    && selection !== null && turnModes !== null && !isSending;

  const addAttachments = (added: readonly ComposerAttachment[]) => {
    setAttachments((current) => appendAttachments(current, added));
  };
  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const send = () => {
    if (!canSend || projectId === null || selection === null || turnModes === null) return;
    // The same text sent again after a failure is the same message: had the
    // first attempt reached the server and only its answer been lost, new ids
    // would create a second chat and run the prompt again.
    const attempt = failedSends.current.find((failed) => (
      failed.projectId === projectId && failed.text === text && sameAttachments(failed.attachments, attachments)
    )) ?? { projectId, text, attachments, chatRequestId: canonicalChatRequestId(), turnRequestId: canonicalChatRequestId() };

    sendMessage.mutate({
      chatId: null,
      baseRevision: 0,
      text,
      attachments,
      selection,
      interactionMode: turnModes.interactionMode,
      permissionMode: turnModes.permissionMode,
      projectId,
      chatRequestId: attempt.chatRequestId,
      turnRequestId: attempt.turnRequestId,
      onChatCreated: (chatId) => {
        failedSends.current = [];
        // The box stays editable while the server answers, so it may hold
        // newer text and attachments by now. Only what was sent is cleared.
        setDraft((current) => (current.trim() === text ? "" : current));
        setAttachments((current) => current.filter((waiting) => !attachments.some((sent) => sent.id === waiting.id)));
        onChatStarted(chatId, selection);
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
    canSend,
    send,
    isSending,
  };
}
