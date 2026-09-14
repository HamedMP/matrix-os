const MAX_DELTA_CHARS = 3_500;

/** Assistant deltas allow whitespace and must preserve every character. */
export function chunkAssistantText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    chunks.push(text.slice(index, index + MAX_DELTA_CHARS));
  }
  return chunks;
}

/** Tool display events require non-blank chunks bounded to 4000 chars / 16KB. */
export function chunkDisplayText(text: string): string[] {
  const out: string[] = [];
  for (const chunk of chunkAssistantText(text)) {
    if (chunk.trim().length === 0) {
      const last = out.at(-1);
      if (last !== undefined && last.length + chunk.length <= 4_000) {
        out[out.length - 1] = last + chunk;
      }
      continue;
    }
    out.push(chunk);
  }
  return out;
}
