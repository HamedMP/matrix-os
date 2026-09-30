/** Byte-addressed JSONL projection reader. The archive retains original bytes separately. */
export type LocalChatSourceRecord = {
  kind: "record"; line: number; offset: number; end: number; value: Record<string, unknown>;
};
export type LocalChatSourceIssue = {
  kind: "issue"; line: number; offset: number; end: number;
  code: "invalid_json" | "invalid_utf8" | "invalid_record" | "empty_line"
    | "record_too_large" | "incomplete_final_line";
};
export type LocalChatSourceEntry = LocalChatSourceRecord | LocalChatSourceIssue;
const DEFAULT_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024 * 1024;

/** A captured live tail is retryable by default; immutable complete files can opt in. */
export async function* readLocalChatJsonl(
  source: AsyncIterable<Uint8Array>,
  options: { maxRecordBytes?: number; finalLine?: "retry" | "complete" } = {},
): AsyncGenerator<LocalChatSourceEntry> {
  const limit = options.maxRecordBytes ?? DEFAULT_RECORD_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_BYTES) throw new Error("Invalid record limit");
  if (options.finalLine !== undefined && options.finalLine !== "retry" && options.finalLine !== "complete") {
    throw new Error("Invalid final line policy");
  }
  let buffer = new Uint8Array(Math.min(1024, limit));
  let length = 0;
  let line = 1;
  let offset = 0;
  let end = 0;
  let tooLarge = false;

  function append(bytes: Uint8Array): void {
    if (tooLarge) return;
    const needed = length + bytes.length;
    if (needed > limit) { tooLarge = true; length = 0; return; }
    if (needed > buffer.length) {
      const grown = new Uint8Array(Math.min(limit, Math.max(needed, buffer.length * 2)));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(bytes, length);
    length = needed;
  }
  function project(complete: boolean): LocalChatSourceEntry {
    const position = { line, offset, end };
    if (!complete) return { kind: "issue", ...position, code: "incomplete_final_line" };
    if (tooLarge) return { kind: "issue", ...position, code: "record_too_large" };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
    catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return { kind: "issue", ...position, code: "invalid_utf8" };
    }
    if (!text.trim()) return { kind: "issue", ...position, code: "empty_line" };
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return { kind: "issue", ...position, code: "invalid_json" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "issue", ...position, code: "invalid_record" };
    }
    return { kind: "record", ...position, value: value as Record<string, unknown> };
  }

  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Invalid source bytes");
    if (end + chunk.length > MAX_SOURCE_BYTES) throw new Error("Source exceeds import limit");
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const boundary = newline === -1 ? chunk.length : newline;
      append(chunk.subarray(cursor, boundary));
      end += boundary - cursor;
      if (newline === -1) break;
      end += 1;
      yield project(true);
      line += 1; offset = end; length = 0; tooLarge = false;
      cursor = boundary + 1;
    }
  }
  if (end > offset) yield project(options.finalLine === "complete");
}
