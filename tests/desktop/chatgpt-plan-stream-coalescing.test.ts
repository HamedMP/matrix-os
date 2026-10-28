import { afterEach, expect, it, vi } from 'vitest';
import { INFERENCE_RESPONSE_CHUNK_MAX_BYTES as MAX } from '@matrix-os/contracts';
import { coalesceNativeResponse } from '../../desktop/src/main/chatgpt-plan/stream-coalescing';

afterEach(() => vi.useRealTimers());
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(source: (signal: AbortSignal) => AsyncIterable<string>) {
  const controller = new AbortController();
  let current = true;
  const stream = coalesceNativeResponse(source, controller.signal, () => current);
  return { stream, controller, changeSource() { current = false; } };
}

it('sends the first bytes immediately and flushes a sparse following batch within 50ms', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const x = setup(async function* (signal) {
    yield 'first'; yield 'second';
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  try {
    expect(await x.stream.next()).toEqual({ value: 'first', done: false });
    const next = x.stream.next();
    let settled = false; void next.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(49); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toEqual({ value: 'second', done: false });
  } finally { await x.stream.return(undefined); }
});

it('bounds prefetch under a stalled sender and preserves all UTF-8 bytes in order', async () => {
  let reads = 0;
  const text = '中'.repeat(Math.floor(MAX / 3));
  const x = setup(async function* () {
    for (let index = 0; index < 12; index++) { reads++; yield text; }
  });
  try {
    const first = await x.stream.next();
    for (let i = 0; i < 10; i++) await tick();
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(3); // Current send + pending + one bounded source item.
    const output = [first.value!];
    for await (const part of x.stream) output.push(part);
    expect(output.join('')).toBe(text.repeat(12));
    expect(output.every(part => Buffer.byteLength(part) <= MAX)).toBe(true);
  } finally { await x.stream.return(undefined); }
});

it('cancels a full pending batch and aborts its source without delivering more bytes', async () => {
  let returned = false, aborted = false;
  const x = setup(async function* (signal) {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    try { while (true) yield 'x'.repeat(MAX); }
    finally { returned = true; }
  });
  await x.stream.next(); await tick();
  x.controller.abort();
  await expect(x.stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  await tick();
  expect(aborted).toBe(true); expect(returned).toBe(true);
});

it('refuses prefetched bytes after the runtime source changes', async () => {
  const x = setup(async function* () { yield 'first'; yield 'stale'; });
  await x.stream.next(); await tick(); x.changeSource();
  await expect(x.stream.next()).rejects.toMatchObject({ category: 'stale_source' });
});

it('observes source failure and retains only the preceding partial bytes', async () => {
  const failure = new Error('synthetic source failure');
  const x = setup(async function* () { yield 'first'; yield 'partial'; throw failure; });
  expect((await x.stream.next()).value).toBe('first');
  expect((await x.stream.next()).value).toBe('partial');
  await expect(x.stream.next()).rejects.toBe(failure);
});

it('bounds Stop even when an upstream next or return ignores cancellation', async () => {
  let signal!: AbortSignal;
  const returned = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const x = setup(value => { signal = value; return {
    [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<string>>(() => {}), return: returned }; },
  }; });
  const next = x.stream.next();
  const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
  x.controller.abort(); await rejected;
  expect(signal.aborted).toBe(true); expect(returned).toHaveBeenCalledOnce();
});

it('rejects oversized source items rather than allowing an unbounded pending batch', async () => {
  const x = setup(async function* () { yield 'x'.repeat(MAX + 1); });
  await expect(x.stream.next()).rejects.toThrow('Native stream item too large');
});

it.each(['cancelled', 'stale'] as const)('does not create upstream work for an already %s source', async kind => {
  const source = vi.fn(async function* () { yield 'must-not-start'; });
  const x = setup(source);
  if (kind === 'cancelled') x.controller.abort(); else x.changeSource();
  await expect(x.stream.next()).rejects.toBeDefined();
  expect(source).not.toHaveBeenCalled();
});

it('emits no empty replies and flushes full chunks without waiting for a timer', async () => {
  vi.useFakeTimers();
  const x = setup(async function* () { yield ''; yield 'a'.repeat(MAX); yield ''; yield 'b'.repeat(MAX); });
  const output: string[] = [];
  for await (const part of x.stream) output.push(part);
  expect(output).toEqual(['a'.repeat(MAX), 'b'.repeat(MAX)]);
  expect(vi.getTimerCount()).toBe(0);
});

it('finishes an empty source without starting a flush timer', async () => {
  vi.useFakeTimers();
  const x = setup(async function* () { yield ''; });
  expect(await x.stream.next()).toEqual({ done: true, value: undefined });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', 'reject'] as const)('keeps cleanup %s failures bounded and out of response data', async mode => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('PRIVATE synthetic cleanup detail');
  const x = setup(() => ({ [Symbol.asyncIterator]() { return {
    async next() { return { done: true, value: undefined }; },
    return() {
      if (mode === 'throw') throw failure;
      return Promise.reject(failure);
    },
  }; } }));
  try {
    expect(await x.stream.next()).toEqual({ done: true, value: undefined });
    await tick();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
  } finally { warn.mockRestore(); }
});
