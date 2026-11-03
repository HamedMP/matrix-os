import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../../desktop/src/main/chatgpt-plan/peer.js';
import { deliveryFixture } from './chatgpt-plan-delivery-support.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function wait(signal: AbortSignal, promise: Promise<void>) {
  let abort!: () => void;
  const interrupted = new Promise<never>((_r, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); await Promise.race([promise, interrupted]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}
describe('real Native -> Hono -> registry receipt delivery, synthetic inference only', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  it.each([false, true])('negotiates v2 and executes one stream when first infer response loss=%s', async loseFirst => {
    const f = await deliveryFixture(); cleanup.push(f.close);
    const app = f.app(), paths: string[] = [], release = gate();
    let lost = false, executions = 0, waiting = false;
    const native = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
      infer: async () => { throw new Error('Legacy inference forbidden'); },
      inferStream: async function* (_request, signal) {
        executions++;
        yield 'data: {"type":"response.output_text.delta","delta":"first"}\n\n';
        waiting = true; await wait(signal, release.promise);
        yield 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      },
      fetchFn: (async (input, init) => {
        const url = new URL(String(input)); if (url.origin !== 'https://fixture.invalid') throw new Error('External requests forbidden');
        const path = url.pathname.split('/').at(-1)!; paths.push(path);
        const response = await app.request(String(input), init);
        if (loseFirst && path === 'poll-v2' && !lost) { lost = true; await response.body?.cancel(); throw new Error('net::ERR_SSL_PROTOCOL_ERROR'); }
        return response;
      }) as typeof fetch,
    });
    cleanup.push(async () => { release.resolve(); await native.stop(); });
    await native.start(f.nativeBinding, f.snapshot);
    expect(paths).toContain('capabilities');
    const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const received: string[] = [];
    const consumer = (async () => { for await (const part of source.body) received.push(part); })();
    await vi.waitFor(() => expect(waiting).toBe(true), { interval: 2 });
    expect(executions).toBe(1);
    release.resolve(); await consumer;
    expect(received.join('')).toBe('data: {"type":"response.output_text.delta","delta":"first"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    expect(paths).not.toContain('poll');
    expect(executions).toBe(1); expect(lost).toBe(loseFirst);
  });
  it('recovers a lost Cancel response and aborts the original source without another inference', async () => {
    const f = await deliveryFixture(); cleanup.push(f.close);
    const app = f.app(), ready = gate(), held = gate();
    let lost = false, executions = 0, closed = false;
    let sourceSignal: AbortSignal | undefined;
    const native = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
      infer: async () => { throw new Error('Legacy forbidden'); },
      inferStream: async function* (_request, signal) {
        executions++; sourceSignal = signal;
        try { yield 'first'; ready.resolve(); await wait(signal, held.promise); yield 'must-not-arrive'; }
        finally { closed = true; }
      },
      fetchFn: (async (input, init) => {
        const response = await app.request(String(input), init);
        if (String(input).includes('/poll-v2') && response.ok) {
          const data = await response.json();
          if (!lost && data.deliveries.some((entry: any) => entry.request.action === 'cancel')) {
            lost = true; throw new Error('net::ERR_SSL_PROTOCOL_ERROR');
          }
          return Response.json(data);
        }
        return response;
      }) as typeof fetch,
    });
    cleanup.push(async () => { held.resolve(); await native.stop(); });
    await native.start(f.nativeBinding, f.snapshot);
    const stop = new AbortController(), source = await f.peers.inferStream(await f.binding(), '{}', stop.signal);
    const received: string[] = [];
    const consumer = (async () => { for await (const part of source.body) received.push(part); })().then(() => 'completed', error => error.message);
    await ready.promise;
    // Read-ahead can reach the provider wait before its first bytes are ACKed.
    // This case cancels after actual Host consumption, not merely source yield.
    await vi.waitFor(() => expect(received).toEqual(['first']), { interval: 2 });
    stop.abort();
    expect(await consumer).toBe('unavailable');
    await vi.waitFor(() => expect(closed).toBe(true), { interval: 2 });
    expect(lost).toBe(true); expect(sourceSignal?.aborted).toBe(true);
    expect(received).toEqual(['first']); expect(executions).toBe(1);
  });
  it('keeps the first inference alive when its receipt response carrying the next infer is lost', async () => {
    const f = await deliveryFixture(); cleanup.push(f.close);
    const app = f.app(), release = gate();
    let lost = false, executions = 0;
    const receipts: number[] = [];
    const native = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
      infer: async () => { throw new Error('Legacy forbidden'); },
      inferStream: async function* (_request, signal) { executions++; yield 'first'; await wait(signal, release.promise); yield 'last'; },
      fetchFn: (async (input, init) => {
        const response = await app.request(String(input), init);
        if (String(input).includes('/poll-v2') && response.ok) {
          const data = await response.json();
          const ack = JSON.parse(String(init?.body)).ackThrough; receipts.push(ack);
          if (!lost && ack === 1 && data.deliveries.length) { lost = true; throw new Error('net::ERR_SSL_PROTOCOL_ERROR'); }
          return Response.json(data);
        }
        return response;
      }) as typeof fetch,
    });
    cleanup.push(async () => { release.resolve(); await native.stop(); });
    await native.start(f.nativeBinding, f.snapshot);
    const first = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const consume = async (source: typeof first) => { const values: string[] = []; for await (const part of source.body) values.push(part); return values; };
    const one = consume(first);
    await vi.waitFor(() => expect(executions).toBe(1), { interval: 2 });
    const second = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal), two = consume(second);
    await vi.waitFor(() => expect(executions).toBe(2), { interval: 2 });
    expect(lost).toBe(true); expect(receipts.slice(0, 3)).toEqual([0, 1, 1]);
    release.resolve(); expect(await one).toEqual(['first', 'last']); expect(await two).toEqual(['first', 'last']);
    expect(executions).toBe(2);
  });
});
