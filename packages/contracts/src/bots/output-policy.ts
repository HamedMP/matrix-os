import type { CanonicalChatMessage } from "#canonical-chat";

/** Presentation storage, independent of attachments, model context and funding. */
export const BOT_OUTPUT_MAX_ENCODED_BYTES = 8 * 1024 * 1024;
export const BOT_OUTPUT_SEGMENT_MAX_ENCODED_BYTES = 96 * 1024;
export const BOT_OUTPUT_MAX_SEGMENTS = 192;
export const BOT_OUTPUT_LIMIT_NOTICE = "\n\nOutput retention limit reached. Tool progress and task status continue.\n";

export const botOutputEncodedBytes = (text: string): number => new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;

/** A JSON/UTF-8 safe prefix; never return half of a surrogate pair. */
export function botOutputPrefix(text: string, maximum: number): string {
  let low = 0;
  let high = Math.min(text.length, Math.max(0, maximum));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    // Search by complete code points: an escaped half-surrogate can cost more
    // bytes than the complete pair, which otherwise breaks binary search.
    const end = /[\uD800-\uDBFF]/u.test(text[middle - 1] ?? "")
      && /[\uDC00-\uDFFF]/u.test(text[middle] ?? "") ? middle - 1 : middle;
    if (botOutputEncodedBytes(text.slice(0, end)) <= maximum) low = middle;
    else high = middle - 1;
  }
  if (low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1] ?? "")) low--;
  return text.slice(0, low);
}

const CONTINUATION_ID = /^(msg_[A-Za-z0-9_-]{1,95})_continued_([1-9][0-9]{0,2})$/;
export function canonicalAssistantOutputRootId(id: string): string {
  const match = id.length <= 128 ? CONTINUATION_ID.exec(id) : null;
  return match && Number(match[2]) < BOT_OUTPUT_MAX_SEGMENTS ? match[1]! : id;
}

export function canonicalAssistantContinuationId(id: string, segment: number): string {
  if (!/^msg_[A-Za-z0-9_-]{1,95}$/.test(id) || !Number.isInteger(segment) || segment < 1 || segment >= BOT_OUTPUT_MAX_SEGMENTS) {
    throw new Error("Invalid assistant output continuation");
  }
  return `${id}_continued_${segment}`;
}

/** Derived display/copy views, NOT canonical wire messages to validate or save.
 * Continuation parts may exceed a single message's schema bounds after joining.
 * Never merge another chat/turn/run, a missing middle, or an ordinary model
 * message. Input snapshots are bounded at 200; the index also caps/evicts for
 * callers projecting a longer already-loaded history. No input is mutated. */
export function canonicalAssistantOutputMessages(messages: readonly CanonicalChatMessage[]): CanonicalChatMessage[] {
  const views: Array<{ message: CanonicalChatMessage; continued: boolean }> = [];
  const groups = new Map<string, { index: number; segment: number }>();
  for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
    if (message.role !== "assistant" || !message.runId || !message.turnId) {
      views.push({ message, continued: false });
      continue;
    }
    const root = canonicalAssistantOutputRootId(message.id);
    const segment = root === message.id ? 0 : Number(CONTINUATION_ID.exec(message.id)![2]);
    const key = JSON.stringify([message.chatId, message.turnId, message.runId, root]);
    const previous = groups.get(key);
    if (segment > 0 && previous && segment === previous.segment + 1) {
      const view = views[previous.index]!;
      view.message = { ...view.message, parts: [...view.message.parts, ...message.parts] };
      view.continued = true;
      previous.segment = segment;
    } else {
      const index = views.length;
      views.push({ message, continued: segment > 0 });
      if (!groups.has(key) && groups.size >= 200) groups.delete(groups.keys().next().value!);
      groups.set(key, { index, segment });
    }
  }
  return views.map(({ message, continued }) => {
    if (!continued) return message;
    const parts: CanonicalChatMessage["parts"] = [];
    let text: string[] = [];
    const flush = () => { if (text.length) { parts.push({ type: "text", text: text.join("") }); text = []; } };
    for (const part of message.parts) {
      if (part.type === "text") text.push(part.text);
      else { flush(); parts.push(part); }
    }
    flush();
    return { ...message, parts };
  });
}
