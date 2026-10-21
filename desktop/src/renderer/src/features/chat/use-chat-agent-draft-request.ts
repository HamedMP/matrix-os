import { useEffect, useRef } from "react";
import type { ChatAgentDraftRequest } from "@matrix-os/ui";
import { chatAgentComposerDraft } from "./chat-agent-draft";

/** Draft intents cannot replace an explicitly routed conversation on remount. */
export function useChatAgentDraftRequest({ request, eligible, prepare, showDraft, focus, onConsumed }: {
  request?: ChatAgentDraftRequest | null;
  eligible: boolean;
  prepare: (draft: ReturnType<typeof chatAgentComposerDraft>) => void;
  showDraft: () => void;
  focus: () => void;
  onConsumed?: (id: number) => void;
}) {
  const consumed = useRef<number | null>(null);
  useEffect(() => {
    if (!eligible || !request || consumed.current === request.id) return;
    consumed.current = request.id;
    prepare(chatAgentComposerDraft(request));
    showDraft();
    focus();
    onConsumed?.(request.id);
  }, [eligible, request, prepare, showDraft, focus, onConsumed]);
}
