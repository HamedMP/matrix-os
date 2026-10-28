import { afterEach, expect, it, vi } from 'vitest';
import { requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses';

const model = 'fixture-model';
const body = JSON.stringify({ model, input: [{ role: 'user', content: 'Offline fixture' }], store: false, stream: true });
const delta = (value: string) =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: value })}\n\n`;
const completion = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed', response: { status: 'completed', model },
})}\n\ndata: [DONE]\n\n`;
const encoder = new TextEncoder();

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function provider(signal = new AbortController().signal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  const input = { fetchFn: vi.fn(async () => response) as typeof fetch, body, model, signal,
    accessToken: async () => 'fixture-token', validate: vi.fn() };
  return { controller: () => controller, input };
}

it('keeps a healthy stream alive beyond two minutes while provider reads keep making progress', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const source = provider();
  const iterator = requestPlanResponseStream(source.input)[Symbol.asyncIterator]();
  source.controller().enqueue(encoder.encode(delta('one')));
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('one') });
  const second = expect(iterator.next()).resolves.toMatchObject({ done: false, value: delta('two') });
  await vi.advanceTimersByTimeAsync(70_000);
  source.controller().enqueue(encoder.encode(delta('two')));
  await second;
  const third = iterator.next().then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  await vi.advanceTimersByTimeAsync(70_000);
  try {
    source.controller().enqueue(encoder.encode(delta('three') + completion));
    source.controller().close();
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error; // The old absolute timer already cancelled the reader.
  }
  expect(await third).toMatchObject({ ok: true, value: { done: false, value: delta('three') } });
  expect(await iterator.next()).toMatchObject({ done: false, value: completion });
  expect(await iterator.next()).toMatchObject({ done: true });
});

it('times out a stream with no provider bytes or consumer progress for two minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const source = provider();
  const iterator = requestPlanResponseStream(source.input)[Symbol.asyncIterator]();
  source.controller().enqueue(encoder.encode(delta('one')));
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('one') });
  const stalled = expect(iterator.next()).rejects.toMatchObject({ category: 'timeout' });
  await vi.advanceTimersByTimeAsync(120_001);
  await stalled;
});

it('Stop cancels an active stream without releasing its terminal event', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stop = new AbortController();
  const source = provider(stop.signal);
  const iterator = requestPlanResponseStream(source.input)[Symbol.asyncIterator]();
  source.controller().enqueue(encoder.encode(delta('one') + completion));
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('one') });
  const next = expect(iterator.next()).rejects.toMatchObject({ category: 'cancelled' });
  stop.abort();
  await next;
});

it('retains the absolute two-minute deadline for legacy one-shot inference', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const source = provider();
  const iterator = requestPlanResponseStream(source.input, false)[Symbol.asyncIterator]();
  source.controller().enqueue(encoder.encode(delta('one')));
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('one') });
  const second = expect(iterator.next()).resolves.toMatchObject({ done: false, value: delta('two') });
  await vi.advanceTimersByTimeAsync(70_000);
  source.controller().enqueue(encoder.encode(delta('two')));
  await second;
  const third = expect(iterator.next()).rejects.toMatchObject({ category: 'timeout' });
  await vi.advanceTimersByTimeAsync(50_001);
  await third;
});
