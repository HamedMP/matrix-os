import { canonicalTranscriptWithPendingSend as pendingSendTranscript, type PendingCanonicalSend } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "@/lib/chat";
import { projectCanonicalMessages } from "@/lib/canonical-chat-client";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";

export { nextPendingCanonicalSend, optimisticCanonicalSendParts, type PendingCanonicalSend } from "@matrix-os/ui";

/** The shared pending-send transcript, projected into web Chat messages. */
export function canonicalTranscriptWithPendingSend(input: {
  detail: CanonicalChatDetailResponse | null;
  pending: PendingCanonicalSend | null;
  activeChatId: string | undefined;
  draftSession: number;
  collaborationViewOpen: boolean;
}): ChatMessage[] {
  const shown = pendingSendTranscript(input);
  if (!shown) return [];
  return shown.kind === "detail" ? projectCanonicalTranscript(shown.detail) : projectCanonicalMessages(shown.transcript.messages);
}
