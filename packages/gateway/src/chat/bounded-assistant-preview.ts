export const ASSISTANT_PREVIEW_TRUNCATED_NOTICE = "\n\nOutput preview truncated. The task continues.\n";
const MAX_PREVIEW_BYTES = 96 * 1024;
const MAX_PREVIEW_MESSAGES = 64;
const encodedTextBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

/** A bounded persisted prefix, not model context or a complete output log.
 * Counting escaped JSON text leaves at least 32 KiB for the canonical message
 * envelope/parts below its 128 KiB cap. Provider deltas are <=4,000 characters,
 * so a 96 KiB prefix also stays well below 64 parts of <=32,000 characters.
 * No text is retained here and message identities are capped without eviction:
 * evicting an identity could reset a credential's absolute offset. */
export function createBoundedAssistantPreview(options: { maxEncodedBytes?: number; maxMessages?: number } = {}) {
  const limit = options.maxEncodedBytes ?? MAX_PREVIEW_BYTES;
  const noticeBytes = encodedTextBytes(ASSISTANT_PREVIEW_TRUNCATED_NOTICE);
  if (limit < noticeBytes) throw new RangeError("Assistant preview budget is too small");
  const messages = new Set<string>();
  let lastMessageId: string | undefined;
  let usedBytes = 0;
  let truncated = false;
  return {
    get truncated() { return truncated; },
    truncate(messageId: string) {
      if (truncated) return undefined;
      truncated = true;
      return { messageId: lastMessageId ?? messageId, delta: ASSISTANT_PREVIEW_TRUNCATED_NOTICE };
    },
    append<Capture extends { offset: number; length: number }>(input: { messageId: string; delta: string; credentials?: readonly Capture[] }) {
      if (truncated) return undefined;
      const newMessage = !messages.has(input.messageId);
      const hasMessageSlot = !newMessage || messages.size < (options.maxMessages ?? MAX_PREVIEW_MESSAGES);
      const available = Math.max(0, limit - noticeBytes - usedBytes);
      let end = hasMessageSlot ? input.delta.length : 0;
      if (encodedTextBytes(input.delta.slice(0, end)) > available) {
        let low = 0;
        let high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (encodedTextBytes(input.delta.slice(0, middle)) <= available) low = middle;
          else high = middle - 1;
        }
        end = low;
      }
      if (end < input.delta.length && /[\uD800-\uDBFF]/u.test(input.delta[end - 1] ?? "")) end--;
      const crossing = input.credentials?.find(capture => capture.offset < end && capture.offset + capture.length > end);
      if (crossing) end = crossing.offset;
      truncated = !hasMessageSlot || end < input.delta.length;
      const prefix = input.delta.slice(0, end);
      usedBytes += encodedTextBytes(prefix);
      if (hasMessageSlot) {
        messages.add(input.messageId);
        lastMessageId = input.messageId;
      }
      const credentials = input.credentials?.filter(capture => capture.offset + capture.length <= end);
      return {
        messageId: hasMessageSlot ? input.messageId : lastMessageId!,
        delta: prefix + (truncated ? ASSISTANT_PREVIEW_TRUNCATED_NOTICE : ""),
        ...(credentials?.length ? { credentials } : {}),
      };
    },
  };
}
