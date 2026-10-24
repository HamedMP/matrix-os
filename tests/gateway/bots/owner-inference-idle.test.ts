import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardBotInference, type BotInferenceDependencies } from '../../../packages/gateway/src/bots/broker-inference.js';
import type { ScopeRuntimeBrokerResult } from '@matrix-os/scope-runtime/broker-protocol';
import type { PiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';

const model = 'claude-owner-test';
const ownerBinding = {
  runtimeHandle: `runtime_${'c'.repeat(32)}`, executionGeneration: '4', ownerId: 'owner', botId: 'bot_12345678',
  chatId: 'chat_owner', taskId: 'task_owner', runId: 'run_owner', rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: model, input: ['text'], contextWindow: 200000, maxOutputTokens: 8192 },
  accessSourceId: 'owner_anthropic_key', capabilities: [], requestClass: 'interactive',
} as const;
const request = { version: 1, action: 'inference.messages', method: 'POST', responseMode: 'stream',
  requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: ownerBinding.runtimeHandle, executionGeneration: '4',
  path: '/v1/messages?beta=true', headers: {}, body: JSON.stringify({ model, stream: true, messages: [], max_tokens: 128 }),
} as const;
function bodyOf(result: ScopeRuntimeBrokerResult): AsyncIterable<string> {
  expect(result.ok).toBe(true);
  if (!result.ok || typeof result.body === 'string') throw new Error('Expected streaming body');
  return result.body;
}
async function collect(body: AsyncIterable<string>) { let result = ''; for await (const chunk of body) result += chunk; return result; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms); return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(options: { intervals?: number[]; chunks?: Uint8Array[]; headersDelay?: number; source?: 'owner_anthropic_key' | 'matrix_included' } = {}) {
  const lifetime = new AbortController(); const source = options.source ?? 'owner_anthropic_key';
  const binding = { ...ownerBinding, accessSourceId: source } as PiRuntimeBinding;
  const frames = ['data: {"step":1}\n\n', 'data: {"step":2}\n\n', 'data: {"step":3}\n\n', 'data: {"done":true}\n\n'];
  const chunks = options.chunks ?? frames.map(value => new TextEncoder().encode(value));
  const intervals = options.intervals ?? [20000, 20000, 20000, 20000];
  let signal!: AbortSignal; let cancelled = false, allowed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init!.signal!;
    if (options.headersDelay) await new Promise<void>((resolve, reject) => {
      const ready = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, options.headersDelay);
      const aborted = () => { clearTimeout(ready); signal.removeEventListener('abort', aborted); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
    });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      let index = 0;
      const aborted = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', aborted); controller.error(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      const next = () => {
        if (index === chunks.length) { signal.removeEventListener('abort', aborted); controller.close(); return; }
        timer = setTimeout(() => { controller.enqueue(chunks[index]!); index++; next(); }, intervals[index] ?? 20000);
      };
      next();
    }, cancel() { cancelled = true; if (timer) clearTimeout(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const authorize = () => ({ allowed, accessSourceId: source, allowedModelIds: [model], allowedEgressOrigins: [] });
  const deps = { homePath: '/tmp', lifetime: lifetime.signal, fetchImpl,
    resolveCredentials: async () => ({ env: { [source === 'matrix_included' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: 'test-only' } }) };
  return { lifetime, fetchImpl, signal: () => signal, cancelled: () => cancelled, revoke: () => { allowed = false; },
    send: (stream = true) => { const { responseMode: _mode, ...legacy } = request; return forwardBotInference(stream ? request : legacy, binding, authorize, deps); },
    cleanup: () => { lifetime.abort(); if (timer) clearTimeout(timer); } };
}

describe('owner Anthropic inference stream idle lifetime', () => {
  it.each(['initial registry', 'initial source', 'credential', 'prefetch registry', 'prefetch source', 'postheaders registry', 'postheaders source', 'chunk registry', 'chunk source'])(
    'bounds stalled owner %s without replay or publishing late authority', async phase => {
      const lifetime = new AbortController(); let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      let credentialReady = false, headersReady = false, streamReturned = false, fetches = 0, cancelled = false;
      let fetchSignal: AbortSignal | undefined;
      const registry = async () => {
        if (phase === 'initial registry' || phase === 'prefetch registry' && credentialReady
          || phase === 'postheaders registry' && headersReady || phase === 'chunk registry' && streamReturned) await stalled;
        return true;
      };
      const deps: BotInferenceDependencies = { homePath: '/tmp', lifetime: lifetime.signal, revalidateBinding: registry,
        matrixAnthropic: { observe: vi.fn(), resolve: vi.fn(), revalidate: async () => {
          if (phase === 'initial source' || phase === 'prefetch source' && credentialReady
            || phase === 'postheaders source' && headersReady || phase === 'chunk source' && streamReturned) await stalled;
          return true;
        }, credential: async () => { if (phase === 'credential') await stalled; credentialReady = true; return 'test-only'; } },
        fetchImpl: async (_url, init) => {
          fetches++; headersReady = true; fetchSignal = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"ready":true}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
        },
      };
      const binding = { ...ownerBinding, anthropicApi: { connectionRevision: 1, credentialGeneration: 'a'.repeat(64) } } as PiRuntimeBinding;
      let settled = false;
      const sent = forwardBotInference(request, binding, () => ({ allowed: true, accessSourceId: 'owner_anthropic_key', allowedModelIds: [model], allowedEgressOrigins: [] }), deps);
      let outcome: Promise<unknown>;
      if (phase.startsWith('chunk')) {
        const iterator = bodyOf(await sent)[Symbol.asyncIterator](); streamReturned = true;
        outcome = iterator.next().then(value => { settled = true; return value; }, () => { settled = true; return 'stream failed'; });
      } else outcome = sent.then(value => { settled = true; return value; }, () => { settled = true; return 'rejected'; });
      try {
        await vi.advanceTimersByTimeAsync(29999); expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
        if (phase.startsWith('chunk')) expect(await outcome).toBe('stream failed');
        else expect(await outcome).toMatchObject({ ok: false });
        release(); await vi.advanceTimersByTimeAsync(0);
        if (headersReady) { expect(fetches).toBe(1); expect(fetchSignal?.aborted).toBe(true); expect(cancelled).toBe(true); }
        else expect(fetches).toBe(0);
      } finally { lifetime.abort(); release(); await outcome; }
    },
  );

  it('keeps Stop as the first cause while an owner setup authority ignores cancellation', async () => {
    const lifetime = new AbortController(); const stop = new DOMException('Stopped first', 'AbortError');
    let signal!: AbortSignal, release!: () => void, fetches = 0;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const sent = forwardBotInference(request, { ...ownerBinding, anthropicApi: { connectionRevision: 1, credentialGeneration: 'a'.repeat(64) } } as PiRuntimeBinding,
      () => ({ allowed: true, accessSourceId: 'owner_anthropic_key', allowedModelIds: [model], allowedEgressOrigins: [] }), {
        homePath: '/tmp', lifetime: lifetime.signal,
        matrixAnthropic: { observe: vi.fn(), resolve: vi.fn(), revalidate: async (_binding, current) => { signal = current; await stalled; return true; }, credential: async () => 'test-only' },
        fetchImpl: async () => { fetches++; return new Response(); },
      });
    try {
      await vi.advanceTimersByTimeAsync(1000); lifetime.abort(stop); await vi.advanceTimersByTimeAsync(0);
      expect(await sent).toMatchObject({ ok: false, error: 'action_denied' });
      expect(signal.reason).toBe(stop);
      release(); await vi.advanceTimersByTimeAsync(60000);
      expect(signal.reason).toBe(stop); expect(fetches).toBe(0); expect(vi.getTimerCount()).toBe(0);
    } finally { lifetime.abort(stop); release(); }
  });

  it('gives each healthy owner setup and authority stage its own window across total elapsed time', async () => {
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20000));
    const sent = forwardBotInference(request, { ...ownerBinding, anthropicApi: { connectionRevision: 1, credentialGeneration: 'a'.repeat(64) } } as PiRuntimeBinding,
      () => ({ allowed: true, accessSourceId: 'owner_anthropic_key', allowedModelIds: [model], allowedEgressOrigins: [] }), {
        homePath: '/tmp', lifetime: new AbortController().signal,
        matrixAnthropic: { observe: vi.fn(), resolve: vi.fn(), revalidate: async () => { await delay(); return true; }, credential: async () => { await delay(); return 'test-only'; } },
        fetchImpl: async () => new Response('data: {"finished":true}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      });
    await vi.advanceTimersByTimeAsync(80000);
    const body = collect(bodyOf(await sent)); await vi.advanceTimersByTimeAsync(40000);
    expect(await body).toBe('data: {"finished":true}\n\n'); expect(vi.getTimerCount()).toBe(0);
  });

  it('renews from partial raw bytes before any complete SSE event exists', async () => {
    const fixture = setup({ intervals: [20000, 20000, 20000], chunks: ['data: {"text":"', 'progress', '"}\n\n'].map(value => new TextEncoder().encode(value)) });
    try {
      const outcome = collect(bodyOf(await fixture.send())).then(text => ({ text }), () => ({ failed: true }));
      await vi.advanceTimersByTimeAsync(60000);
      expect(await outcome).toEqual({ text: 'data: {"text":"progress"}\n\n' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('settles ignored fetch abort at the header deadline and disposes a late response', async () => {
    let lateResponse!: (response: Response) => void, settled = false, cancelled = false;
    const outcome = forwardBotInference(request, ownerBinding, () => ({ allowed: true, accessSourceId: 'owner_anthropic_key', allowedModelIds: [model], allowedEgressOrigins: [] }), {
      homePath: '/tmp', lifetime: new AbortController().signal,
      resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: 'test-only' } }),
      fetchImpl: async () => new Promise<Response>(resolve => { lateResponse = resolve; }),
    }).then(value => { settled = true; return value; });
    const late = () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    try {
      await vi.advanceTimersByTimeAsync(30000); expect(settled).toBe(true);
      expect(await outcome).toMatchObject({ ok: false });
      lateResponse(late()); await vi.advanceTimersByTimeAsync(0); expect(cancelled).toBe(true);
    } finally { lateResponse(late()); await outcome; }
  });

  it('retains a thirty-second time-to-headers bound', async () => {
    const fixture = setup({ headersDelay: 31000 });
    try {
      let settled = false; const outcome = fixture.send().then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(29999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await outcome).toMatchObject({ ok: false });
      expect(fixture.signal().reason).toMatchObject({ name: 'TimeoutError' });
    } finally { fixture.cleanup(); }
  });

  it('does not charge downstream backpressure time as upstream body idleness', async () => {
    const fixture = setup();
    try {
      const iterator = bodyOf(await fixture.send())[Symbol.asyncIterator](); const first = iterator.next();
      await vi.advanceTimersByTimeAsync(20000); expect((await first).value).toBe('data: {"step":1}\n\n');
      await vi.advanceTimersByTimeAsync(90000); expect(fixture.signal().aborted).toBe(false);
      expect(await collect({ [Symbol.asyncIterator]: () => iterator })).toBe('data: {"step":2}\n\ndata: {"step":3}\n\ndata: {"done":true}\n\n');
      expect(vi.getTimerCount()).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('Stop still interrupts an awaiting body read immediately', async () => {
    const fixture = setup();
    try {
      let settled = false; const outcome = collect(bodyOf(await fixture.send())).then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(45000); expect(settled).toBe(false);
      fixture.lifetime.abort(new DOMException('Stopped', 'AbortError'));
      await vi.advanceTimersByTimeAsync(0); expect(await outcome).toBe('failed');
      expect(fixture.signal().reason).toMatchObject({ name: 'AbortError' });
    } finally { fixture.cleanup(); }
  });

  it('rejects the next body frame after the current owner authority is revoked', async () => {
    const fixture = setup();
    try {
      let seen = ''; const outcome = (async () => { for await (const part of bodyOf(await fixture.send())) seen += part; })().then(() => 'completed', () => 'failed');
      await vi.advanceTimersByTimeAsync(45000); fixture.revoke();
      await vi.advanceTimersByTimeAsync(15000); expect(await outcome).toBe('failed');
      expect(seen).toBe('data: {"step":1}\n\ndata: {"step":2}\n\n');
      expect(fixture.signal().aborted).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it('keeps funded generation at its original 120-second hard deadline despite progress', async () => {
    const fixture = setup({ source: 'matrix_included', intervals: Array.from({ length: 8 }, () => 20000), chunks: Array.from({ length: 8 }, () => new TextEncoder().encode('data: {"progress":true}\n\n')) });
    try {
      let settled = false; const outcome = collect(bodyOf(await fixture.send())).then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(119999); expect(settled).toBe(false); expect(fixture.signal().aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await outcome).toBe('failed'); expect(fixture.signal().reason).toMatchObject({ name: 'TimeoutError' });
    } finally { fixture.cleanup(); }
  });

  it('keeps legacy owner buffered inference on its original absolute thirty-second deadline', async () => {
    const fixture = setup();
    try {
      const outcome = fixture.send(false);
      await vi.advanceTimersByTimeAsync(30000); expect(await outcome).toMatchObject({ ok: false });
      expect(fixture.signal().reason).toMatchObject({ name: 'TimeoutError' });
    } finally { fixture.cleanup(); }
  });

  it('ends after thirty seconds without real body bytes and cancels the owned fetch', async () => {
    const fixture = setup({ intervals: [20000, 31000] });
    try {
      const body = bodyOf(await fixture.send());
      let settled = false;
      const outcome = collect(body).then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(49999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
      expect(await outcome).toBe('failed'); expect(fixture.signal().aborted).toBe(true); expect(fixture.cancelled()).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it('does not let empty transport chunks renew the body idle window', async () => {
    const fixture = setup({ intervals: [10000, 10000, 10000, 20000], chunks: [new TextEncoder().encode('data: {"step":1}\n\n'), new Uint8Array(), new Uint8Array(), new TextEncoder().encode('data: {"done":true}\n\n')] });
    try {
      let settled = false;
      const outcome = collect(bodyOf(await fixture.send())).then(() => { settled = true; return 'completed'; }, () => { settled = true; return 'failed'; });
      await vi.advanceTimersByTimeAsync(39999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true); expect(await outcome).toBe('failed');
    } finally { fixture.cleanup(); }
  });

  it('keeps healthy real body reads alive past 30 seconds total and completes once', async () => {
    const fixture = setup();
    try {
      const result = await fixture.send();
      const completed = collect(bodyOf(result)).then(text => ({ text }), () => ({ failed: true }));
      await vi.advanceTimersByTimeAsync(30001);
      expect(fixture.signal().aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(49999);
      expect(await completed).toEqual({ text: 'data: {"step":1}\n\ndata: {"step":2}\n\ndata: {"step":3}\n\ndata: {"done":true}\n\n' });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.cleanup(); }
  });
});
