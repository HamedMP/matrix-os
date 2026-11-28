import type { ReactNode } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { type StageChatWorktreeDraft, useChatElectronPreview } from "./ChatElectronPreview";
import { useChatMacTerminalWatch } from "./ChatMacTerminalWatch";
import { useChatMacTerminalProbe } from "./ChatMacTerminalProbe";
import type { MacVerificationDraft } from "./ChatMacVerification";
import type { ComposerMentionAction } from "./ComposerMentionActions";

export function ChatWorktreeActions({ active, editingQueuedTurn, actorId, detail, onDraft, onDiscardDraft, children }: {
  active: boolean;
  editingQueuedTurn?: boolean;
  actorId: string | null;
  detail: CanonicalChatDetailResponse;
  onDraft?: StageChatWorktreeDraft;
  onDiscardDraft: (text: string) => void;
  children: (actions: readonly ComposerMentionAction[], verification?: MacVerificationDraft) => ReactNode;
}) {
  const preview = useChatElectronPreview({ active, editingQueuedTurn, actorId, detail, onDraft });
  const terminal = useChatMacTerminalProbe({
    active, actorId, detail, onDraft, onDiscardDraft, previewAvailable: preview.available,
  });
  const watch = useChatMacTerminalWatch(terminal.watchScope);
  const actions = [
    ...(preview.verificationAction ? [preview.verificationAction] : []),
    ...(preview.action ? [preview.action] : []),
    ...(watch.inUse ? [] : terminal.actions),
    ...(watch.action ? [watch.action] : []),
  ];

  return (
    <>
      {preview.verificationFeedback}
      {preview.feedback}
      {terminal.feedback}
      {watch.feedback}
      {children(actions, preview.verificationDraft)}
    </>
  );
}
