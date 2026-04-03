import { describe, it, expect } from "vitest";
import { RingBuffer, type BufferChunk } from "../../packages/gateway/src/ring-buffer.js";

describe("RingBuffer", () => {
  it("starts with zero bytes and seq 0", () => {
    const buf = new RingBuffer();
    expect(buf.currentBytes).toBe(0);
    expect(buf.nextSeq).toBe(0);
  });

  it("writes a chunk and reads it back", () => {
    const buf = new RingBuffer();
    const seq = buf.write("hello");
    expect(seq).toBe(0);
    expect(buf.getAll()).toEqual([{ seq: 0, data: "hello" }]);
  });

  it("increments sequence numbers monotonically", () => {
    const buf = new RingBuffer();
    expect(buf.write("a")).toBe(0);
    expect(buf.write("b")).toBe(1);
    expect(buf.write("c")).toBe(2);
    expect(buf.nextSeq).toBe(3);
  });

  it("tracks currentBytes accurately using UTF-8 byte length", () => {
    const buf = new RingBuffer();
    buf.write("hello"); // 5 bytes
    expect(buf.currentBytes).toBe(5);
    buf.write("world"); // 5 bytes
    expect(buf.currentBytes).toBe(10);
  });

  it("counts multi-byte UTF-8 characters correctly", () => {
    const buf = new RingBuffer();
    const emoji = "\u{1F600}"; // 4 bytes in UTF-8
    buf.write(emoji);
    expect(buf.currentBytes).toBe(Buffer.byteLength(emoji));
  });

  it("evicts oldest chunks when exceeding maxBytes", () => {
    const buf = new RingBuffer(10); // 10 byte limit
    buf.write("12345"); // 5 bytes, seq 0
    buf.write("67890"); // 5 bytes, seq 1 -- now at 10 bytes
    buf.write("abcde"); // 5 bytes, seq 2 -- evicts seq 0

    const chunks = buf.getAll();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].seq).toBe(1);
    expect(chunks[1].seq).toBe(2);
    expect(buf.currentBytes).toBe(10);
  });

  it("evicts multiple chunks if needed for a large write", () => {
    const buf = new RingBuffer(10);
    buf.write("aaa"); // 3 bytes, seq 0
    buf.write("bbb"); // 3 bytes, seq 1
    buf.write("ccc"); // 3 bytes, seq 2 -- 9 bytes total
    buf.write("12345678"); // 8 bytes, seq 3 -- must evict all three to fit

    const chunks = buf.getAll();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ seq: 3, data: "12345678" });
    expect(buf.currentBytes).toBe(8);
  });

  it("getSince returns chunks with seq >= given seq", () => {
    const buf = new RingBuffer();
    buf.write("a"); // seq 0
    buf.write("b"); // seq 1
    buf.write("c"); // seq 2
    buf.write("d"); // seq 3

    const result = buf.getSince(2);
    expect(result).toEqual([
      { seq: 2, data: "c" },
      { seq: 3, data: "d" },
    ]);
  });

  it("getSince(0) returns all chunks", () => {
    const buf = new RingBuffer();
    buf.write("x");
    buf.write("y");

    const result = buf.getSince(0);
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(0);
    expect(result[1].seq).toBe(1);
  });

  it("getSince with seq beyond buffer returns empty array", () => {
    const buf = new RingBuffer();
    buf.write("a"); // seq 0
    buf.write("b"); // seq 1

    expect(buf.getSince(100)).toEqual([]);
  });

  it("getSince on empty buffer returns empty array", () => {
    const buf = new RingBuffer();
    expect(buf.getSince(0)).toEqual([]);
  });

  it("getAll on empty buffer returns empty array", () => {
    const buf = new RingBuffer();
    expect(buf.getAll()).toEqual([]);
  });

  it("clear resets currentBytes to 0", () => {
    const buf = new RingBuffer();
    buf.write("hello");
    buf.write("world");
    expect(buf.currentBytes).toBe(10);

    buf.clear();
    expect(buf.currentBytes).toBe(0);
    expect(buf.getAll()).toEqual([]);
  });

  it("clear does not reset nextSeq — sequences never go backward", () => {
    const buf = new RingBuffer();
    buf.write("a"); // seq 0
    buf.write("b"); // seq 1
    expect(buf.nextSeq).toBe(2);

    buf.clear();
    expect(buf.nextSeq).toBe(2);

    const seq = buf.write("c");
    expect(seq).toBe(2);
    expect(buf.nextSeq).toBe(3);
  });

  it("handles single chunk exactly at maxBytes", () => {
    const buf = new RingBuffer(5);
    buf.write("12345"); // exactly 5 bytes
    expect(buf.currentBytes).toBe(5);
    expect(buf.getAll()).toHaveLength(1);
  });

  it("handles write of empty string", () => {
    const buf = new RingBuffer();
    const seq = buf.write("");
    expect(seq).toBe(0);
    expect(buf.currentBytes).toBe(0);
    expect(buf.getAll()).toEqual([{ seq: 0, data: "" }]);
  });

  it("handles many writes and evictions correctly", () => {
    const buf = new RingBuffer(20);
    for (let i = 0; i < 100; i++) {
      buf.write(`msg${i}`);
    }
    expect(buf.nextSeq).toBe(100);
    expect(buf.currentBytes).toBeLessThanOrEqual(20);
    const all = buf.getAll();
    expect(all.length).toBeGreaterThan(0);
    // All remaining chunks should have incrementing seqs
    for (let i = 1; i < all.length; i++) {
      expect(all[i].seq).toBeGreaterThan(all[i - 1].seq);
    }
  });

  it("getSince with evicted seq returns only available chunks", () => {
    const buf = new RingBuffer(10);
    buf.write("12345"); // seq 0
    buf.write("67890"); // seq 1
    buf.write("abcde"); // seq 2 -- evicts seq 0

    // Asking for seq 0 which has been evicted, should return what's available
    const result = buf.getSince(0);
    expect(result).toEqual([
      { seq: 1, data: "67890" },
      { seq: 2, data: "abcde" },
    ]);
  });
});
