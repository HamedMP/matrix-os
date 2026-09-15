import { canonicalChatInputs, canonicalChatApprovals, canonicalChatTerminalNotices, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";
import { projectCanonicalMessages } from "./canonical-chat-client";

/** Keep terminal outcomes attached to their turn, using only safe fixed copy. */
export function projectCanonicalTranscript(detail: CanonicalChatDetailResponse): ChatMessage[] {
  const messages = projectCanonicalMessages(detail.messages);
  for (const approval of canonicalChatApprovals(detail)) {
    const existing = messages.find(message => message.id === approval.id);
    if (existing) {
      existing.metadata = { ...existing.metadata, canonicalApproval: approval };
      continue;
    }
    const index = approval.beforeMessageId ? messages.findIndex(message => message.id === approval.beforeMessageId) : -1;
    messages.splice(index < 0 ? messages.length : index, 0, {
      id: approval.id, role: "system", requestId: approval.runId,
      content: approval.title, timestamp: approval.timestamp,
      metadata: { canonicalApproval: approval },
    });
  }
  for (const input of canonicalChatInputs(detail)) {
    const index = input.beforeMessageId ? messages.findIndex(message => message.id === input.beforeMessageId) : -1;
    messages.splice(index < 0 ? messages.length : index, 0, {
      id: input.id, role: "system", requestId: input.runId,
      content: input.title, timestamp: input.timestamp,
      metadata: { canonicalInput: input },
    });
  }
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const nextIndex = notice.beforeMessageId ? messages.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, {
      id: notice.id, role: "system", requestId: notice.runId,
      content: notice.text, timestamp: notice.timestamp,
    });
  }
  return messages;
}
