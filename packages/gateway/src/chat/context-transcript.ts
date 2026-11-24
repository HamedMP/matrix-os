import type { CanonicalChatMessage } from "@matrix-os/contracts";

export function transcript(messages: CanonicalChatMessage[], limit: number): { text: string; truncated: boolean } {
  const lines = messages.filter((message) => message.state === "committed"
    && (message.role === "user" || message.role === "assistant"))
    .flatMap((message) => {
      const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      return text ? [`${message.role === "user" ? "User" : "Assistant"}: ${text}`] : [];
    });
  const text = lines.join("\n\n");
  const bytes = Buffer.from(text);
  let offset = Math.max(0, bytes.length - limit);
  // Start at a UTF-8 code point boundary without inventing replacement characters.
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset += 1;
  return {
    text: bytes.length > limit ? bytes.subarray(offset).toString("utf8") : text,
    truncated: bytes.length > limit,
  };
}
