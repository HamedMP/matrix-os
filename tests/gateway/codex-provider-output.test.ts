import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { consumeCodexProviderOutput, MAX_CODEX_TRANSPORT_BYTES } from "../../packages/gateway/src/coding-agents/codex-provider-output.mjs";

async function parse(chunks: Buffer[]) {
  const messages: unknown[] = [];
  await consumeCodexProviderOutput(Readable.from(chunks), async (value) => { messages.push(value); });
  return messages;
}

describe("bounded Codex JSON transport", () => {
  it("preserves UTF-8 split across reads, CRLF, blank lines and a final unterminated message", async () => {
    const input = Buffer.from('\n\r\n{"delta":"你好🌈"}\r\n{"id":2}');
    expect(await parse([...input].map((byte) => Buffer.from([byte])))).toEqual([{ delta: "你好🌈" }, { id: 2 }]);
  });

  it.each([-1, 0])("accepts a frame at the byte limit offset %i", async (offset) => {
    const frame = Buffer.from(JSON.stringify("a".repeat(MAX_CODEX_TRANSPORT_BYTES - 2 + offset)));
    const values = await parse([frame.subarray(0, 101), frame.subarray(101), Buffer.from('\n{"id":2}\n')]);
    expect((values[0] as string).length).toBe(MAX_CODEX_TRANSPORT_BYTES - 2 + offset);
    expect(values[1]).toEqual({ id: 2 });
  });

  it.each([false, true])("rejects an oversized frame before parsing, chunked=%s", async (chunked) => {
    const frame = Buffer.alloc(MAX_CODEX_TRANSPORT_BYTES + 1, 65);
    const chunks = chunked ? [frame.subarray(0, 100), frame.subarray(100)] : [frame];
    await expect(parse(chunks)).rejects.toMatchObject({ category: "oversized", bytes: frame.length });
  });

  it.each([Buffer.from('{"private":"secret"'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])])("rejects malformed JSON/UTF-8 without embedding content", async (frame) => {
    await expect(parse([frame])).rejects.toMatchObject({ category: "malformed", bytes: frame.length, message: "Codex transport malformed" });
  });

  it("does not swallow handler failures or read subsequent messages", async () => {
    let calls = 0;
    const error = new Error("handler stopped");
    await expect(consumeCodexProviderOutput(Readable.from([Buffer.from('{}\n{}\n')]), async () => {
      calls += 1; throw error;
    })).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});
