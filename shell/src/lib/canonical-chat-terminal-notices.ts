import { canonicalChatApprovals, canonicalChatTerminalNotices, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";
import { projectCanonicalMessages } from "./canonical-chat-client";

/** Keep terminal outcomes attached to their turn, using only safe fixed copy. */
export function projectCanonicalTranscript(detail: CanonicalChatDetailResponse): ChatMessage[] {
  const messages = projectCanonicalMessages(detail.messages);
  const contextsByTurn = Object.fromEntries(detail.runs.filter((run) => run.context).map((run) => [run.turnId, run.context]));
  const sourceById = Object.fromEntries(detail.messages.map((message) => [message.id, message]));
  for (const message of messages) {
    const source = sourceById[message.id];
    const context = source?.turnId ? contextsByTurn[source.turnId] : undefined;
    if (source?.role === "user" && context) message.metadata = { ...message.metadata, chatRunContext: context };
  }
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
  for (const notice of canonicalChatTerminalNotices(detail)) {
    const nextIndex = notice.beforeMessageId ? messages.findIndex((message) => message.id === notice.beforeMessageId) : -1;
    messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, {
      id: notice.id, role: "system", requestId: notice.runId,
      content: notice.text, timestamp: notice.timestamp,
    });
  }
  return messages;
}
