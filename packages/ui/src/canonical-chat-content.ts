import { mergeCanonicalChatRecord } from "./canonical-chat-record";
import { MAX_LOADED_CHAT_MESSAGES } from "./chat/use-canonical-chat-history";
import type { CanonicalChatContentFrame, CanonicalChatDetailResponse } from "@matrix-os/contracts";

function upsert<T extends { id: string }>(current: T[], incoming: T[] = []): T[] {
  const result = [...current];
  for (const item of incoming) {
    const index = result.findIndex((existing) => existing.id === item.id);
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}

/** null means a gap: recover a snapshot, never guess missing text or ordering. */
export function applyCanonicalChatContent(
  detail: CanonicalChatDetailResponse,
  frame: CanonicalChatContentFrame,
): CanonicalChatDetailResponse | null {
  if (detail.record.chat.id !== frame.event.chatId || detail.record.chat.revision >= frame.event.revision) return detail;
  if (detail.record.chat.revision + 1 !== frame.event.revision) return null;
  const content = frame.content;
  let messages = upsert(detail.messages, content.messages);
  if (content.messageDelta) {
    const { message, partIndex, offset } = content.messageDelta;
    const delta = message.parts[0];
    if (delta?.type !== "text") return null;
    const existing = messages.find((item) => item.id === message.id);
    if (!existing) {
      if (offset !== 0 || partIndex !== 0) return null;
      messages = upsert(messages, [message]);
    } else {
      if (existing.runId !== message.runId || existing.turnId !== message.turnId || existing.state !== "pending") return null;
      const parts = [...existing.parts];
      const part = parts[partIndex];
      if (partIndex === parts.length && offset === 0) parts.push(delta);
      else if (part?.type === "text" && part.text.length === offset) {
        parts[partIndex] = { type: "text", text: part.text + delta.text };
      } else return null;
      messages = upsert(messages, [{ ...existing, parts }]);
    }
  }
  const sortedMessages = messages.sort((a, b) => a.seq - b.seq);
  // Keep a loaded prefix across streaming updates. Silently sliding a 200-row
  // window also invalidates its opaque server cursor and hides human messages.
  if (sortedMessages.length > MAX_LOADED_CHAT_MESSAGES) return null;
  const windowMessages = sortedMessages;
  const turnIds = windowMessages.flatMap((message) => message.turnId ? [message.turnId] : []);
  const turns = upsert(detail.turns, content.turns).filter((turn) => turnIds.includes(turn.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const runIds = windowMessages.flatMap((message) => message.runId ? [message.runId] : []);
  const runs = upsert(detail.runs, content.runs)
    .filter((run) => runIds.includes(run.id) || turns.some((turn) => turn.id === run.turnId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const visibleRunIds = runs.map((run) => run.id);
  const next = {
    ...detail,
    record: mergeCanonicalChatRecord(detail.record, content.record),
    messages: windowMessages,
    turns,
    runs,
    activities: upsert(detail.activities.filter((activity) => !content.removedActivityIds?.includes(activity.id)), content.activities)
      .filter((activity) => visibleRunIds.includes(activity.runId))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.runId.localeCompare(b.runId)
        || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id)).slice(-500),
    ...(content.queuedTurns === undefined ? {} : { queuedTurns: content.queuedTurns }),
    ...(content.terminalSessionIds === undefined ? {} : { terminalSessionIds: content.terminalSessionIds }),
  };
  return next;
}
