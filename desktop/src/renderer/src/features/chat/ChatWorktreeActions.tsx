import type { ReactNode } from "react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { type StageChatWorktreeDraft, useChatElectronPreview } from "./ChatElectronPreview";
import { useChatMacTerminalProbe } from "./ChatMacTerminalProbe";
import type { ComposerMentionAction } from "./ComposerMentionActions";

export function ChatWorktreeActions({ active, actorId, detail, onDraft, onDiscardDraft, children }: {
  active: boolean;
  actorId: string | null;
  detail: CanonicalChatDetailResponse;
  onDraft?: StageChatWorktreeDraft;
  onDiscardDraft: (text: string) => void;
  children: (actions: readonly ComposerMentionAction[]) => ReactNode;
}) {
  const preview = useChatElectronPreview({ active, actorId, detail, onDraft });
  const terminal = useChatMacTerminalProbe({
    active, actorId, detail, onDraft, onDiscardDraft, previewAvailable: preview.available,
  });
  const actions = preview.action ? [preview.action, ...terminal.actions] : terminal.actions;

  return (
    <>
      {preview.feedback}
      {terminal.feedback}
      {children(actions)}
    </>
  );
}
