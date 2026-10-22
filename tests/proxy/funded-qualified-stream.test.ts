import { describe, expect, it, vi } from 'vitest';
import { coalesceQualifiedResponse } from '../../packages/proxy/src/funded-qualified-stream.js';
const encode = (text: string) => new TextEncoder().encode(text);
describe('bounded qualified response release batches', () => {
  it('coalesces individual token chunks into one bounded release batch without changing bytes', async () => {
    let index = 0; const source = new ReadableStream<Uint8Array>({ pull(c) { if (index === 100) c.close(); else c.enqueue(encode(String(index++ % 10))); } });
    const reader = coalesceQualifiedResponse(source).getReader(); const chunks: Uint8Array[] = [];
    for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
    expect(chunks.length).toBeLessThan(4); expect(chunks.every(c => c.length <= 65536)).toBe(true); expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('0123456789'.repeat(10));
  });
  it('splits a large normalized JSON chunk into bounded batches and preserves all bytes', async () => {
    const input = new Uint8Array(65536 * 2 + 1).fill(65); const stream = coalesceQualifiedResponse(new ReadableStream({ start(c) { c.enqueue(input); c.close(); } }));
    const reader = stream.getReader(); const sizes: number[] = []; for (;;) { const r = await reader.read(); if (r.done) break; sizes.push(r.value.length); }
    expect(sizes).toEqual([65536, 65536, 1]);
  });
  it('flushes a pending batch on the time bound and keeps the single pending read for the next pull', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const reader = coalesceQualifiedResponse(new ReadableStream({ start(c) { source = c; c.enqueue(encode('one')); } }), { windowMs: 10 }).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('one'); source.enqueue(encode('two')); source.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('two'); expect((await reader.read()).done).toBe(true);
  });
  it('rejects repeated empty chunks instead of spinning without a byte limit', async () => {
    const cancel = vi.fn(); const reader = coalesceQualifiedResponse(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel })).getReader();
    await expect(reader.read()).rejects.toThrow('AI response stream failed'); expect(cancel).toHaveBeenCalledOnce();
  });
  it('propagates cancellation and drains the source', async () => {
    const cancel = vi.fn(); const reader = coalesceQualifiedResponse(new ReadableStream({ pull: () => new Promise(() => undefined), cancel })).getReader();
    await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
});
