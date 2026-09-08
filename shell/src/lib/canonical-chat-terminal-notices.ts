import { canonicalChatTerminalNotices, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";
import { projectCanonicalMessages } from "./canonical-chat-client";

/** Keep terminal outcomes attached to their turn, using only safe fixed copy. */
export function projectCanonicalTranscript(detail: CanonicalChatDetailResponse): ChatMessage[] {
  const messages = projectCanonicalMessages(detail.messages);
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const nextIndex = notice.beforeMessageId ? messages.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, {
      id: notice.id, role: "system", requestId: notice.runId,
      content: notice.text, timestamp: notice.timestamp,
    });
  }
  return messages;
}
