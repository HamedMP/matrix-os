import { supervisedToolApproval, supervisedToolRetryDraft, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { ConversationPresentationCallbacks } from "../../components/conversation/presentation";
import type { canonicalChatPresentation } from "./canonical-chat-presentation";
import type { CanonicalComposerSelection } from "./canonical-composer-state";

type Transcript = ReturnType<typeof canonicalChatPresentation>;

/** The first tool request still waiting, repeated above the composer. */
export function pendingSupervisedTool(turns: Transcript): { id: string; bar: string } | null {
  for (const turn of turns) {
    for (const item of turn.work) {
      if (item.kind !== "request" || item.requestKind !== "approval" || item.state !== "waiting") continue;
      const view = supervisedToolApproval({
        title: item.label,
        description: item.detail,
        pending: true,
        decision: item.decision,
        reason: item.reason,
        allowedDecisions: (item.actions ?? []).flatMap((action) => action.kind === "approval" ? [action.decision] : []),
      });
      if (view?.kind === "waiting") return { id: item.requestId, bar: view.bar };
    }
  }
  return null;
}

/** Always allow changes the next request's mode, and only for an agent that offers Full access. */
export function supervisedToolCallbacks(input: {
  selection: CanonicalComposerSelection | null | undefined;
  catalog: CanonicalProviderCatalog | null | undefined;
  directBot: boolean;
  onSelectionChange: (selection: CanonicalComposerSelection) => void;
  draft: string;
  setDraft: (text: string) => void;
}): Pick<ConversationPresentationCallbacks, "permissionMode" | "onPermissionMode" | "onTryAgain"> {
  const { selection, catalog, directBot, onSelectionChange, draft, setDraft } = input;
  const fullAccess = !directBot && selection && catalog?.instances.some((instance) => (
    instance.id === selection.instanceId && instance.supports.permissionModes.includes("full_access")
  ));
  return {
    permissionMode: selection?.permissionMode,
    ...(fullAccess ? { onPermissionMode: (mode) => onSelectionChange({ ...selection, permissionMode: mode }) } : {}),
    // Try again adds to the composer so the owner can resend; unsent text stays and nothing is sent for them.
    onTryAgain: (prompt) => {
      setDraft(supervisedToolRetryDraft(draft, prompt));
      if (typeof document === "undefined") return;
      document.querySelector<HTMLElement>("[data-slot=shared-chat-composer] :is(textarea, [contenteditable=true])")?.focus();
    },
  };
}
