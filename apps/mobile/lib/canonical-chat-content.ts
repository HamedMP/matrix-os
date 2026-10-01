import type {
  CanonicalChatContentFrame,
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
} from "@matrix-os/contracts";

type MessageDelta = NonNullable<CanonicalChatContentFrame["content"]["messageDelta"]>;

function upsert<T extends { id: string }>(current: T[], incoming: T[] = []): T[] {
  const result = [...current];
  for (const item of incoming) {
    const index = result.findIndex((existing) => existing.id === item.id);
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}

/**
 * A delta carries only the newly generated text plus the offset it starts at.
 * Returns null unless it continues exactly where the held text ends.
 */
function appendTextDelta(
  messages: CanonicalChatMessage[],
  { message, partIndex, offset }: MessageDelta,
): CanonicalChatMessage[] | null {
  const delta = message.parts[0];
  if (!delta) return null;
  const existing = messages.find((item) => item.id === message.id);
  if (!existing) {
    // First delta of a reply: the delta message is the whole message so far.
    return offset === 0 && partIndex === 0 ? upsert(messages, [message]) : null;
  }
  if (existing.state !== "pending" || existing.runId !== message.runId || existing.turnId !== message.turnId) {
    return null;
  }

  const parts = [...existing.parts];
  const part = parts[partIndex];
  if (partIndex === parts.length && offset === 0) {
    parts.push(delta);
  } else if (part?.type === "text" && part.text.length === offset) {
    parts[partIndex] = { type: "text", text: part.text + delta.text };
  } else {
    return null;
  }
  return upsert(messages, [{ ...existing, parts }]);
}

/**
 * Applies one streamed `chat.content` frame to a cached chat detail -- the
 * mobile counterpart of desktop's reducer in
 * `packages/ui/src/canonical-chat-content.ts`.
 *
 * Every frame moves the chat exactly one revision forward. Returns the same
 * `detail` when the frame is already reflected, and `null` when a frame was
 * missed: the caller then refetches a snapshot rather than guessing at text.
 */
export function applyCanonicalChatContent(
  detail: CanonicalChatDetailResponse,
  frame: CanonicalChatContentFrame,
): CanonicalChatDetailResponse | null {
  const { event, content } = frame;
  const revision = detail.record.chat.revision;
  if (detail.record.chat.id !== event.chatId || revision >= event.revision) return detail;
  if (revision + 1 !== event.revision) return null;

  let messages = upsert(detail.messages, content.messages);
  if (content.messageDelta) {
    const appended = appendTextDelta(messages, content.messageDelta);
    if (!appended) return null;
    messages = appended;
  }

  const removedActivityIds = new Set(content.removedActivityIds);
  return {
    ...detail,
    record: content.record,
    messages,
    turns: upsert(detail.turns, content.turns),
    runs: upsert(detail.runs, content.runs),
    activities: upsert(
      detail.activities.filter((activity) => !removedActivityIds.has(activity.id)),
      content.activities,
    ),
    ...(content.queuedTurns === undefined ? {} : { queuedTurns: content.queuedTurns }),
    ...(content.terminalSessionIds === undefined ? {} : { terminalSessionIds: content.terminalSessionIds }),
  };
}

/**
 * Applies frames in arrival order. Stops at the first one that does not fit --
 * that frame and everything after it come back as `unapplied`, to be retried
 * once a newer snapshot has been fetched.
 */
export function applyCanonicalChatContentFrames(
  detail: CanonicalChatDetailResponse,
  frames: CanonicalChatContentFrame[],
): { detail: CanonicalChatDetailResponse; unapplied: CanonicalChatContentFrame[] } {
  let current = detail;
  for (const [index, frame] of frames.entries()) {
    const next = applyCanonicalChatContent(current, frame);
    if (!next) return { detail: current, unapplied: frames.slice(index) };
    current = next;
  }
  return { detail: current, unapplied: [] };
}
