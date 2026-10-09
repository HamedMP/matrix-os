import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useRef, useState } from "react";

import { useSendChatMessage } from "@/lib/queries/use-send-chat-message";
import { canonicalChatRequestId } from "@/lib/requests/canonical-chat";

// A failed send's request ids are kept until a send goes through; beyond this
// many the oldest is dropped.
const MAX_FAILED_SENDS = 8;

interface FailedSend {
  projectId: string;
  text: string;
  chatRequestId: string;
  turnRequestId: string;
}

interface ProjectComposerOptions {
  /** The project a sent message starts a chat in: its id, not its slug. */
  projectId: string | null;
  selection: CanonicalChatModelSelection | null;
  turnModes: { interactionMode: string; permissionMode: string } | null;
  /** Holds sends back, as while there is no model to send to yet. */
  disabled?: boolean;
  /** Called once the new chat's first message is admitted, with the model it was started with. */
  onChatStarted: (chatId: string, selection: CanonicalChatModelSelection) => void;
}

/**
 * The composer of a project screen: every message it sends starts a new chat
 * in the project, through the same request path as the chat screen. This
 * screen has no transcript to show a sent message in, so the text stays in the
 * box until the server has it.
 */
export function useProjectComposer({
  projectId,
  selection,
  turnModes,
  disabled = false,
  onChatStarted,
}: ProjectComposerOptions) {
  const sendMessage = useSendChatMessage();
  const isSending = sendMessage.isPending;
  const [draft, setDraft] = useState("");
  const failedSends = useRef<FailedSend[]>([]);

  const text = draft.trim();
  const canSend = !disabled && projectId !== null && text !== "" && selection !== null && turnModes !== null && !isSending;

  const send = () => {
    if (!canSend || projectId === null || selection === null || turnModes === null) return;
    // The same text sent again after a failure is the same message: had the
    // first attempt reached the server and only its answer been lost, new ids
    // would create a second chat and run the prompt again.
    const attempt = failedSends.current.find((failed) => failed.projectId === projectId && failed.text === text)
      ?? { projectId, text, chatRequestId: canonicalChatRequestId(), turnRequestId: canonicalChatRequestId() };

    sendMessage.mutate({
      chatId: null,
      baseRevision: 0,
      text,
      selection,
      interactionMode: turnModes.interactionMode,
      permissionMode: turnModes.permissionMode,
      projectId,
      chatRequestId: attempt.chatRequestId,
      turnRequestId: attempt.turnRequestId,
      onChatCreated: (chatId) => {
        failedSends.current = [];
        setDraft("");
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

  return { draft, setDraft, canSend, send, isSending };
}
