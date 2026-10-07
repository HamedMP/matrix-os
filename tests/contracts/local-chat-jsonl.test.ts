import { describe, expect, it } from "vitest";
import { readLocalChatJsonl } from "../../packages/contracts/src/local-chat-import/jsonl.js";

async function* chunks(bytes: Uint8Array, size = 1) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
}
async function read(text: string, options = {}) {
  return Array.fromAsync(readLocalChatJsonl(chunks(new TextEncoder().encode(text)), options));
}

describe("local Chat original record reader", () => {
  it("preserves source byte offsets across split multibyte UTF-8 and CRLF", async () => {
    const first = '{"text":"hé🌱"}\r\n';
    const second = '{"type":"unknown","encrypted_content":"opaque"}\n';
    const records = await read(first + second);
    expect(records).toEqual([
      { kind: "record", line: 1, offset: 0, end: new TextEncoder().encode(first).length, value: { text: "hé🌱" } },
      { kind: "record", line: 2, offset: new TextEncoder().encode(first).length,
        end: new TextEncoder().encode(first + second).length, value: { type: "unknown", encrypted_content: "opaque" } },
    ]);
  });
  it("retains malformed middle lines as issues and continues without inventing messages", async () => {
    expect(await read('{"ok":1}\n{bad}\n{"ok":2}\n')).toEqual([
      { kind: "record", line: 1, offset: 0, end: 9, value: { ok: 1 } },
      { kind: "issue", line: 2, offset: 9, end: 15, code: "invalid_json" },
      { kind: "record", line: 3, offset: 15, end: 24, value: { ok: 2 } },
    ]);
  });
  it("keeps an unfinished final line retryable at its exact byte boundary", async () => {
    expect(await read('{"ok":1}\n{"partial":')).toEqual([
      { kind: "record", line: 1, offset: 0, end: 9, value: { ok: 1 } },
      { kind: "issue", line: 2, offset: 9, end: 20, code: "incomplete_final_line" },
    ]);
  });
  it("can parse a complete immutable final record without a newline", async () => {
    expect(await read('{"ok":1}', { finalLine: "complete" })).toEqual([
      { kind: "record", line: 1, offset: 0, end: 8, value: { ok: 1 } },
    ]);
  });
  it("does not replace invalid UTF-8 with different source text", async () => {
    const records = await Array.fromAsync(readLocalChatJsonl(chunks(Uint8Array.of(123,34,120,34,58,34,255,34,125,10))));
    expect(records).toEqual([{ kind: "issue", line: 1, offset: 0, end: 10, code: "invalid_utf8" }]);
  });
  it("reports a record over the projection limit and recovers the next line", async () => {
    const first = JSON.stringify({ text: "x".repeat(100) }) + "\n";
    expect(await read(first + '{}\n', { maxRecordBytes: 32 })).toEqual([
      { kind: "issue", line: 1, offset: 0, end: first.length, code: "record_too_large" },
      { kind: "record", line: 2, offset: first.length, end: first.length + 3, value: {} },
    ]);
  });
  it("accepts a valid record larger than observed 3.36 MB records without truncation", async () => {
    const text = "x".repeat(4 * 1024 * 1024);
    const result = await Array.fromAsync(readLocalChatJsonl(chunks(new TextEncoder().encode(JSON.stringify({ text }) + "\n"), 65536)));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "record", value: { text } });
  });
  it("reports blank and non-object lines as source issues", async () => {
    expect(await read('\n[]\nnull\n')).toEqual([
      { kind: "issue", line: 1, offset: 0, end: 1, code: "empty_line" },
      { kind: "issue", line: 2, offset: 1, end: 4, code: "invalid_record" },
      { kind: "issue", line: 3, offset: 4, end: 9, code: "invalid_record" },
    ]);
  });
  it("rejects invalid configured limits before reading", async () => {
    await expect(read('{}\n', { maxRecordBytes: 0 })).rejects.toThrow("Invalid record limit");
  });
});
