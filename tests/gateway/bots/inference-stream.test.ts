import { describe, expect, it, vi } from 'vitest';
import { forwardBotInference, type BotInferenceDependencies } from '../../../packages/gateway/src/bots/broker-inference.js';
import type { ChatGptPlanAuthority } from '../../../packages/gateway/src/bots/chatgpt-plan.js';
import type { PiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import type { ScopeRuntimeBrokerResult } from '@matrix-os/scope-runtime/broker-protocol';
import { createFundedAdmissionQueue } from '../../../packages/gateway/src/funded-ai/admission-queue.js';
import { INFERENCE_RESPONSE_CHUNK_MAX_BYTES } from '@matrix-os/contracts';

const model = 'gpt-stream-test';
const binding = {
  runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner', botId: 'bot_12345678',
  chatId: 'chat_test', taskId: 'task_test', runId: 'run_test', rootFingerprint: 'a'.repeat(64),
  route: { api: 'openai-responses', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'matrix_chatgpt_plan', subscription: { peerId: 'peer', accountId: 'account', computerId: 'computer', grantRevision: 1 },
  capabilities: [], requestClass: 'interactive',
} as const;
const request = { version: 1, action: 'inference.responses', method: 'POST', responseMode: 'stream',
  requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
  path: '/v1/responses', headers: {}, body: JSON.stringify({ model, stream: true, input: [{ role: 'user', content: 'Hello' }] }),
} as const;
const event = (type: string, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const delta = event('response.output_text.delta', { delta: 'First text' });
const completed = event('response.completed', { response: { status: 'completed', model } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function* pieces(...chunks: string[]) { yield* chunks; }
function streamOf(result: ScopeRuntimeBrokerResult): AsyncIterable<string> {
  expect(result.ok).toBe(true);
  if (!result.ok || typeof result.body === 'string') throw new Error('Expected an incremental inference stream');
  return result.body;
}
async function collect(body: AsyncIterable<string>) { let text = ''; for await (const chunk of body) text += chunk; return text; }
function fixture(source: AsyncIterable<string> = pieces(delta, completed)) {
  const lifetime = new AbortController();
  const authority: ChatGptPlanAuthority = { observe: vi.fn(), resolve: vi.fn(), revalidate: vi.fn(async () => true),
    infer: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: completed })),
    inferStream: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: source })),
  };
  const deps = { homePath: '/tmp', lifetime: lifetime.signal, chatgptPlan: authority };
  const authorize = () => ({ allowed: true, accessSourceId: 'matrix_chatgpt_plan', allowedModelIds: [model], allowedEgressOrigins: [] }) as const;
  const send = () => forwardBotInference(request, binding, authorize, deps);
  return { authority, lifetime, deps, send };
}

describe('incremental Bot inference', () => {
  it('publishes a delta before EOF and holds completed until EOF and final revalidation', async () => {
    const eof = deferred();
    async function* source() { yield delta; yield completed; await eof.promise; }
    const f = fixture(source()); const iterator = streamOf(await f.send())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(delta);
    let settled = false; const terminal = iterator.next().then(value => { settled = true; return value; });
    await new Promise<void>(r => setImmediate(r)); expect(settled).toBe(false);
    eof.resolve(); expect((await terminal).value).toBe(completed); expect((await iterator.next()).done).toBe(true);
    expect(f.authority.infer).not.toHaveBeenCalled();
  });

  it('withholds DONE as well as completed until the real source EOF', async () => {
    const eof = deferred();
    async function* source() { yield delta; yield completed + 'data: [DONE]\n\n'; await eof.promise; }
    const f = fixture(source()); const iterator = streamOf(await f.send())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(delta);
    let settled = false; const terminal = iterator.next().then(value => { settled = true; return value; });
    await new Promise<void>(r => setImmediate(r)); expect(settled).toBe(false);
    eof.resolve(); let tail = (await terminal).value ?? '';
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) tail += chunk;
    expect(tail).toBe(completed + 'data: [DONE]\n\n');
  });

  it('streams a reply whose aggregate exceeds the old one-MiB cap', async () => {
    const text = event('response.output_text.delta', { delta: 'x'.repeat(32768) });
    const f = fixture(pieces(...Array.from({ length: 40 }, () => text), completed));
    const result = await collect(streamOf(await f.send())); expect(result).toBe(text.repeat(40) + completed);
  });

  it('splits non-ASCII output into bounded UTF-8 chunks without corruption', async () => {
    const text = event('response.output_text.delta', { delta: '汉'.repeat(30000) });
    const f = fixture(pieces(text, completed)); let result = '';
    for await (const chunk of streamOf(await f.send())) { expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(INFERENCE_RESPONSE_CHUNK_MAX_BYTES); result += chunk; }
    expect(result).toBe(text + completed);
  });

  it('handles CRLF delimiters split across upstream chunks', async () => {
    const wire = (delta + completed).replace(/\n/g, '\r\n');
    const f = fixture(pieces(...Array.from(wire))); expect(await collect(streamOf(await f.send()))).toBe(delta + completed);
  });

  it.each([
    ['missing terminal', delta], ['late error', completed + event('error')],
    ['wrong model', event('response.completed', { response: { status: 'completed', model: 'foreign' } })],
    ['duplicate terminal', completed + completed], ['late error after DONE', completed + 'data: [DONE]\n\n' + event('error')], ['truncated tail', completed + 'data: {'],
    ['malformed JSON', 'data: {bad}\n\n'], ['mismatched event name', 'event: response.completed\ndata: {"type":"response.created"}\n\n'],
    ['oversized event', event('response.output_text.delta', { delta: 'x'.repeat(1024 * 1024) })],
  ])('never releases completed for %s', async (_name, wire) => {
    const f = fixture(pieces(wire)); const body = streamOf(await f.send()); let seen = '';
    await expect((async () => { for await (const chunk of body) seen += chunk; })()).rejects.toThrow();
    expect(seen).not.toContain('event: response.completed');
  });

  it('fails closed when streaming authority is unavailable rather than using buffered infer', async () => {
    const f = fixture(); delete f.authority.inferStream;
    expect(await f.send()).toMatchObject({ ok: false }); expect(f.authority.infer).not.toHaveBeenCalled();
  });

  it('withholds completed when authority is revoked at EOF', async () => {
    const f = fixture(); let valid = true;
    f.authority.revalidate = async () => valid;
    async function* source() { yield delta; yield completed; valid = false; }
    f.authority.inferStream = async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: source() });
    const body = streamOf(await f.send()); let seen = ''; await expect((async () => { for await (const part of body) seen += part; })()).rejects.toThrow();
    expect(seen).toBe(delta);
  });

  it('aborts a stalled stream promptly and does not release completed', async () => {
    async function* source() { yield delta; await new Promise<void>(() => {}); }
    const f = fixture(source()); const iterator = streamOf(await f.send())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(delta);
    const pending = iterator.next(); f.lifetime.abort(); await expect(pending).rejects.toThrow();
  });

  it('consumer return aborts the authority-owned request', async () => {
    const f = fixture(); const iterator = streamOf(await f.send())[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.();
    expect(vi.mocked(f.authority.inferStream!).mock.calls[0]![2].aborted).toBe(true);
  });

  it('retains the 120-second subscription deadline during a stalled stream', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms); return controller.signal;
    });
    try {
      async function* source() { yield delta; await new Promise<void>(() => {}); }
      const f = fixture(source()); const iterator = streamOf(await f.send())[Symbol.asyncIterator]();
      await iterator.next(); const pending = iterator.next(); let settled = false;
      const result = pending.then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(119999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('failed');
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('preserves the buffered compatibility path when responseMode is omitted', async () => {
    const f = fixture(); const { responseMode: _mode, ...legacy } = request;
    expect(await forwardBotInference(legacy, binding, () => ({ allowed: true, accessSourceId: 'matrix_chatgpt_plan', allowedModelIds: [model], allowedEgressOrigins: [] }), f.deps)).toMatchObject({ ok: true, body: completed });
    expect(f.authority.inferStream).not.toHaveBeenCalled();
  });

  it.each(['owner_anthropic_key', 'matrix_included'] as const)('bounds %s unfinished SSE events across transport chunks and cancels upstream', async accessSourceId => {
    let reads = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 35) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(reads === 1 ? 'data: {"text":"' : 'x'.repeat(32768)));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const bound = { ...binding, subscription: undefined, accessSourceId, route: { ...binding.route, api: 'anthropic-messages' } } as PiRuntimeBinding;
    const req = { ...request, action: 'inference.messages', path: '/v1/messages?beta=true', body: JSON.stringify({ model, stream: true, messages: [] }) } as const;
    const result = await forwardBotInference(req, bound, () => ({ allowed: true, accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), {
      homePath: '/tmp', lifetime: new AbortController().signal, fetchImpl: async () => response,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } }),
    });
    const streamed = streamOf(result); let deliveredBytes = 0;
    await expect((async () => { for await (const part of streamed) deliveredBytes += Buffer.byteLength(part); })()).rejects.toThrow('response_too_large');
    expect(deliveredBytes).toBe(0); expect(cancelled).toBe(true);
  });

  it.each(['owner_anthropic_key', 'matrix_included'] as const)('continues %s valid small SSE events beyond one MiB total', async accessSourceId => {
    const frame = 'data: ' + JSON.stringify({ text: '汉'.repeat(12000) }) + '\r\n\r\n';
    const wire = ': keepalive\r\n\r\n' + frame.repeat(32);
    const encoder = new TextEncoder(); const bytes = encoder.encode(wire);
    let offset = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 4093); controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const bound = { ...binding, subscription: undefined, accessSourceId, route: { ...binding.route, api: 'anthropic-messages' } } as PiRuntimeBinding;
    const req = { ...request, action: 'inference.messages', path: '/v1/messages?beta=true', body: JSON.stringify({ model, stream: true, messages: [] }) } as const;
    const result = await forwardBotInference(req, bound, () => ({ allowed: true, accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), {
      homePath: '/tmp', lifetime: new AbortController().signal, fetchImpl: async () => response,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } }),
    });
    expect({ exactNormalizedWire: await collect(streamOf(result)) === wire.replace(/\r\n/g, '\n') }).toEqual({ exactNormalizedWire: true });
  });

  it('rejects an unfinished non-subscription SSE event at EOF before exposing it', async () => {
    const accessSourceId = 'owner_anthropic_key' as const;
    const bound = { ...binding, subscription: undefined, accessSourceId, route: { ...binding.route, api: 'anthropic-messages' } } as PiRuntimeBinding;
    const req = { ...request, action: 'inference.messages', path: '/v1/messages?beta=true', body: JSON.stringify({ model, stream: true, messages: [] }) } as const;
    const result = await forwardBotInference(req, bound, () => ({ allowed: true, accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), {
      homePath: '/tmp', lifetime: new AbortController().signal, fetchImpl: async () => new Response('data: {"partial":true}', { headers: { 'content-type': 'text/event-stream' } }),
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } }),
    });
    const streamed = streamOf(result); let seen = ''; await expect((async () => { for await (const part of streamed) seen += part; })()).rejects.toThrow();
    expect(seen).toBe('');
  });

  it.each([['owner_anthropic_key', 30000], ['matrix_included', 120000]] as const)('retains %s per-call deadline while streaming', async (accessSourceId, deadline) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms); return controller.signal;
    });
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    const bound = { ...binding, subscription: undefined, accessSourceId, route: { ...binding.route, api: 'anthropic-messages' } } as PiRuntimeBinding;
    const req = { ...request, action: 'inference.messages', path: '/v1/messages?beta=true', body: JSON.stringify({ model, stream: true, messages: [] }) } as const;
    const deps: BotInferenceDependencies = { homePath: '/tmp', lifetime: new AbortController().signal, fetchImpl: async () => response,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } }) };
    try {
      const iterator = streamOf(await forwardBotInference(req, bound, () => ({ allowed: true, accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), deps))[Symbol.asyncIterator]();
      let settled = false;
      const result = iterator.next().then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(deadline - 1); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('failed');
      await vi.runAllTimersAsync(); expect(cancelled).toBe(true);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each(['owner_anthropic_key', 'matrix_included'] as const)('streams %s before upstream EOF while retaining output authority', async accessSourceId => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    const fundedAdmission = createFundedAdmissionQueue();
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => response);
    const deps: BotInferenceDependencies = { homePath: '/tmp', lifetime: new AbortController().signal, fundedAdmission, fetchImpl,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only', ANTHROPIC_BASE_URL: 'https://test.invalid' } }) };
    const bound = { ...binding, subscription: undefined, accessSourceId, route: { ...binding.route, api: 'anthropic-messages' } } as PiRuntimeBinding;
    const req = { ...request, action: 'inference.messages', path: '/v1/messages?beta=true', body: JSON.stringify({ model, stream: true, messages: [], max_tokens: 123 }) } as const;
    try {
      const result = await forwardBotInference(req, bound, () => ({ allowed: true, accessSourceId, allowedModelIds: [model], allowedEgressOrigins: [] }), deps);
      const iterator = streamOf(result)[Symbol.asyncIterator](); upstream.enqueue(new TextEncoder().encode('data: first\n\n'));
      expect((await iterator.next()).value).toBe('data: first\n\n');
      expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).max_tokens).toBe(123);
      upstream.close(); expect((await iterator.next()).done).toBe(true);
    } finally { fundedAdmission.close(); }
  });
});
