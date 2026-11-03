import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryRequest, nativeDeliveryFixture } from './chatgpt-plan-poll-support';
import { logPlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
describe('bounded v2 receipt recovery and fail-closed authority', () => {
  const fixtures: ReturnType<typeof nativeDeliveryFixture>[] = [];
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it('does not borrow the generic SSL code when a nested cause is unknown', async () => {
    const f = nativeDeliveryFixture({ steps: [() => { throw new Error('net::ERR_SSL_PROTOCOL_ERROR', { cause: { code: 'UNRECOGNIZED_SECURITY_FAILURE' } }); }] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true), { interval: 2 });
    expect(f.polls).toHaveLength(2);
    expect(f.state.signal?.aborted).toBe(true);
  });
  it.each(['ERR_CERT_AUTHORITY_INVALID', 'ERR_ACCESS_DENIED', 'ERR_CONNECTION_RESET', 'ERR_FAILED'])('closes rather than retrying %s', async code => {
    const f = nativeDeliveryFixture({ steps: [() => { throw new Error(`net::${code}`); }] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true), { interval: 2 });
    expect(f.polls).toHaveLength(2); expect(f.state.signal?.aborted).toBe(true);
  });
  it.each([false, true])('gives certificate causes priority over SSL matching, deeper=%s', async deep => {
    const cause = deep ? { code: 'ECONNREFUSED', cause: { code: 'CERT_HAS_EXPIRED' } } : { code: 'CERT_HAS_EXPIRED' };
    const f = nativeDeliveryFixture({ steps: [() => { throw new Error('net::ERR_SSL_PROTOCOL_ERROR', { cause }); }] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true), { interval: 2 }); expect(f.polls).toHaveLength(2);
  });
  it('recovers one body-read SSL loss with the same ACK and active inference', async () => {
    const f = nativeDeliveryFixture({ steps: [() => new Response(new ReadableStream({ start(c) { c.error(new Error('net::ERR_SSL_PROTOCOL_ERROR')); } })),
      () => Response.json({ version: 2, sessionId: f.sessionId, acknowledgedThrough: 1, deliveries: [] })] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.polls).toHaveLength(4), { interval: 2 });
    expect(f.state.executions).toBe(1); expect(f.state.signal?.aborted).toBe(false);
    expect(f.polls[1]).toEqual(f.polls[2]);
    expect(f.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', category: 'network_error', networkDiagnostic: expect.objectContaining({ phase: 'body_read' }) }));
    f.release.resolve(); await vi.waitFor(() => expect(f.replies.some(reply => reply.stream === 'end')).toBe(true), { interval: 2 });
  });
  it('stops on the second consecutive recoverable failure without re-executing inference', async () => {
    const failure = () => { throw new Error('net::ERR_SSL_PROTOCOL_ERROR'); };
    const f = nativeDeliveryFixture({ steps: [failure, failure] }); fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true), { interval: 2 });
    expect(f.polls).toHaveLength(3); expect(f.state.executions).toBe(1); expect(f.state.signal?.aborted).toBe(true);
  });
  it('does not let Cancel pre-scan consume the high-water of an earlier unrelated infer', async () => {
    const a = deliveryRequest(1), b = deliveryRequest(2);
    const f = nativeDeliveryFixture({ first: [a, b, { version: 1, action: 'cancel', id: b.id }] }); fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.polls).toHaveLength(2), { interval: 2 });
    expect(f.state.executions).toBe(1); expect(f.polls[1]).toMatchObject({ ackThrough: 3 }); expect(f.state.signal?.aborted).toBe(false);
  });
  it('source revocation wins over a retryable transport error', async () => {
    const f = nativeDeliveryFixture({ steps: [() => { f.state.current = false; throw new Error('net::ERR_SSL_PROTOCOL_ERROR'); }] }); fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true), { interval: 2 }); expect(f.polls).toHaveLength(2);
  });
  it.each(['404', '403', 'html', 'session'])('does not silently fall back for invalid capabilities: %s', async kind => {
    const f = nativeDeliveryFixture({ capability: () => kind === 'html' ? new Response('<html>') : kind === 'session'
      ? Response.json({ version: 1, sessionId: '20000000-0000-4000-8000-000000000001', pollDeliveryVersion: 2 })
      : new Response('', { status: Number(kind) }) }); fixtures.push(f);
    await expect(f.start()).rejects.toThrow(); expect(f.polls).toEqual([]); expect(f.paths).not.toContain('poll'); expect(f.state.executions).toBe(0);
  });
  it('accepts a valid image-bearing poll above ordinary POST 2 MiB without enlarging the poll cap', async () => {
    const png = Buffer.alloc(1600000); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const request = deliveryRequest(); request.body = JSON.stringify({ input: [{ role: 'user', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,' + png.toString('base64') },
    ] }] });
    expect(Buffer.byteLength(request.body)).toBeGreaterThan(2 * 1024 * 1024);
    const f = nativeDeliveryFixture({ first: [request] }); fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.executions).toBe(1), { interval: 2 }); expect(f.state.signal?.aborted).toBe(false);
  });
  it('keeps a v2 poll alive through 12 seconds rather than applying the ordinary 10-second POST deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Deadline', 'TimeoutError')), ms);
      return controller.signal;
    });
    const f = nativeDeliveryFixture({ steps: [signal => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ version: 2, sessionId: f.sessionId, acknowledgedThrough: 1, deliveries: [] })), 12000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    })] }); fixtures.push(f); await f.start(); await f.ready.promise;
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(11000);
    expect(f.state.signal?.aborted).toBe(false); expect(f.state.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(f.polls).toHaveLength(3); expect(f.state.executions).toBe(1);
  });
  it('retains the fixed capability failure stage in the bounded diagnostic recorder', async () => {
    const f = nativeDeliveryFixture({ capability: () => new Response('', { status: 404 }) }); fixtures.push(f);
    await f.start().catch(error => logPlanFailure('peer_rebind', error));
    expect(f.records).toContainEqual(expect.objectContaining({ stage: 'peer_capabilities', category: 'http_error', httpStatus: 404 }));
  });
  it.each([512, 513])('enforces exact and one-byte-over response size in the shared bounded reader: %s', async bytes => {
    const f = nativeDeliveryFixture({ capability: () => {
      const json = JSON.stringify({ version: 1, sessionId: f.sessionId, pollDeliveryVersion: 2 });
      return new Response(json + ' '.repeat(bytes - Buffer.byteLength(json)));
    } }); fixtures.push(f);
    if (bytes === 512) { await f.start(); expect(f.paths).toContain('poll-v2'); }
    else { await expect(f.start()).rejects.toThrow('response_oversize'); expect(f.polls).toEqual([]); }
  });
});
