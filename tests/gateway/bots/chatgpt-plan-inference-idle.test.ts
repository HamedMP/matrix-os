import { afterEach, expect, it, vi } from 'vitest';
import { forwardChatGptPlanInference } from '../../../packages/gateway/src/bots/chatgpt-plan-inference.js';
import type { ChatGptPlanAuthority } from '../../../packages/gateway/src/bots/chatgpt-plan.js';
import type { PiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';

const model = 'gpt-idle-fixture';
const binding = {
  runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner', botId: 'bot_12345678',
  chatId: 'chat_fixture', taskId: 'task_fixture', runId: 'run_fixture', rootFingerprint: 'a'.repeat(64),
  route: { api: 'openai-responses', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_chatgpt_plan', capabilities: [], requestClass: 'interactive',
  subscription: { peerId: '10000000-0000-4000-8000-000000000001', accountId: 'account', computerId: 'computer', grantRevision: 1 },
} as PiRuntimeBinding;
const frame = {
  version: 1, action: 'inference.responses', method: 'POST', requestId: '20000000-0000-4000-8000-000000000001',
  runtimeHandle: binding.runtimeHandle, executionGeneration: '1', path: '/v1/responses', headers: {},
  responseMode: 'stream', body: JSON.stringify({ model, stream: true, input: [{ role: 'user', content: 'Fixture' }] }),
} as const;
const event = (type: string, extra = {}) => `data: ${JSON.stringify({ type, ...extra })}\n\n`;
const delta = event('response.output_text.delta', { delta: 'fixture' });
const completed = event('response.completed', { response: { status: 'completed', model } });

function source() {
  let waiting: ((value: IteratorResult<string>) => void) | undefined;
  const pending: IteratorResult<string>[] = [];
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() { return this; },
    next() { if (pending.length) return Promise.resolve(pending.shift()!);
      return new Promise(resolve => { waiting = resolve; }); },
    return: vi.fn(async () => { waiting?.({ value: undefined, done: true }); waiting = undefined; return { value: undefined, done: true as const }; }),
  };
  const emit = (value: IteratorResult<string>) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); }
    else { if (pending.length >= 2) throw new Error('Fixture queue is full'); pending.push(value); }
  };
  return { iterator, chunk: (value: string) => emit({ value, done: false }), end: () => emit({ value: undefined, done: true }) };
}
function clocks() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // AbortSignal.timeout uses native timers; route those through the same test clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
}
function fixture() {
  const input = source(), lifetime = new AbortController();
  let signal: AbortSignal | undefined;
  const authority: ChatGptPlanAuthority = { resolve: vi.fn(), observe: vi.fn(), revalidate: vi.fn(async () => true), infer: vi.fn(),
    inferStream: vi.fn(async (_binding, _body, activeSignal) => {
      signal = activeSignal;
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: input.iterator };
    }),
  };
  const send = () => forwardChatGptPlanInference(frame, binding, { authority, signal: lifetime.signal, stillAuthorized: () => true });
  return { input, authority, lifetime, send, signal: () => signal };
}
async function streamed(f: ReturnType<typeof fixture>) {
  const response = await f.send();
  if (!response.ok || typeof response.body === 'string') throw new Error('Fixture stream was refused');
  return response.body[Symbol.asyncIterator]();
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps a healthy subscription body alive across the old 120 second absolute deadline', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  let read = iterator.next(); f.input.chunk(delta); expect((await read).value).toBe(delta);
  await vi.advanceTimersByTimeAsync(90000);
  read = iterator.next(); f.input.chunk(delta); expect((await read).value).toBe(delta);
  await vi.advanceTimersByTimeAsync(90000);
  expect(f.signal()?.aborted).toBe(false);
  read = iterator.next(); f.input.chunk(completed); await Promise.resolve(); f.input.end();
  expect((await read).value).toBe(completed);
  expect((await iterator.next()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds headers even when an authority ignores cancellation', async () => {
  clocks(); const f = fixture();
  f.authority.inferStream = vi.fn(() => new Promise<never>(() => {}));
  let outcome: Awaited<ReturnType<typeof f.send>> | undefined;
  void f.send().then(value => { outcome = value; });
  await vi.advanceTimersByTimeAsync(120000);
  expect(outcome).toMatchObject({ ok: false, error: 'action_denied' });
});

it('clears its idle timer when Stop arrives before the returned body is consumed', async () => {
  clocks(); const f = fixture();
  expect((await f.send()).ok).toBe(true);
  f.lifetime.abort();
  expect(f.signal()?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('ends after exactly 120 seconds without a first body chunk and clears its timer', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next(), rejected = expect(read).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(119999); expect(f.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  f.input.end();
});

it('does not extend the body idle lease for empty chunks', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next(), rejected = expect(read).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(90000); f.input.chunk('');
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30000); await rejected;
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  f.input.end();
});

it('keeps a partially received SSE event alive through real body read progress', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next();
  for (const piece of [delta.slice(0, 8), delta.slice(8, 16)]) {
    await vi.advanceTimersByTimeAsync(90000); f.input.chunk(piece);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signal()?.aborted).toBe(false);
  }
  f.input.chunk(delta.slice(16)); expect((await read).value).toBe(delta);
  await iterator.return?.();
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('Stop cancels a stalled active body promptly and clears its idle timer', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next(), rejected = expect(read).rejects.toThrow();
  f.lifetime.abort(); await rejected;
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  f.input.end();
});

it('withholds completed when source authority is revoked at EOF', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next(), rejected = expect(read).rejects.toThrow();
  f.authority.revalidate = vi.fn(async () => false);
  f.input.chunk(completed); f.input.end(); await rejected;
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('preserves the legacy whole-response absolute deadline', async () => {
  clocks(); const f = fixture();
  f.authority.infer = vi.fn(async (_binding, _body, signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { responseMode: _stream, ...legacy } = frame;
  const pending = forwardChatGptPlanInference(legacy, binding, { authority: f.authority, signal: f.lifetime.signal, stillAuthorized: () => true });
  await vi.advanceTimersByTimeAsync(120000);
  expect(await pending).toMatchObject({ ok: false, error: 'action_denied' });
  expect(f.authority.inferStream).not.toHaveBeenCalled();
});

it.each(['continue', 'Stop'] as const)('does not count downstream backpressure as upstream idle before %s', async action => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  let read = iterator.next(); f.input.chunk(delta); expect((await read).value).toBe(delta);
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.signal()?.aborted).toBe(false);
  if (action === 'Stop') {
    f.lifetime.abort();
    await expect(iterator.next()).rejects.toThrow();
  } else {
    read = iterator.next(); f.input.chunk(completed); f.input.end();
    expect((await read).value).toBe(completed);
    expect((await iterator.next()).done).toBe(true);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('does not time out a validated terminal while its consumer is paused', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  const read = iterator.next(); f.input.chunk(completed); f.input.end();
  expect((await read).value).toBe(completed);
  await vi.advanceTimersByTimeAsync(180000); expect(f.signal()?.aborted).toBe(false);
  expect((await iterator.next()).done).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('starts a fresh 120 second idle interval when its consumer requests more data', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  let read = iterator.next(); f.input.chunk(delta); await read;
  await vi.advanceTimersByTimeAsync(180000); expect(f.signal()?.aborted).toBe(false);
  read = iterator.next(); const rejected = expect(read).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(119999); expect(f.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(vi.getTimerCount()).toBe(0); f.input.end();
});

it('still bounds a first body that is never consumed', async () => {
  clocks(); const f = fixture(); await f.send();
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.signal()?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('keeps authority checks bounded while upstream idle is paused for received data', async () => {
  clocks(); const f = fixture(); const iterator = await streamed(f);
  let read = iterator.next(); f.input.chunk(delta); await read;
  f.authority.revalidate = vi.fn(() => new Promise<never>(() => {}));
  read = iterator.next(); const rejected = expect(read).rejects.toThrow();
  f.input.chunk(delta);
  await vi.advanceTimersByTimeAsync(120000); await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
