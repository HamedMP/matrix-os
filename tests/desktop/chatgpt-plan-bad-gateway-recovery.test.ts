import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { retryableDeliveryFailure } from '../../desktop/src/main/chatgpt-plan/poll-delivery';
import { sendNativeStreamReply } from '../../desktop/src/main/chatgpt-plan/reply-delivery';
import { nativeDeliveryFixture } from './chatgpt-plan-poll-support';

describe('negotiated receipt recovery after a gateway 502', () => {
  const fixtures: ReturnType<typeof nativeDeliveryFixture>[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
    vi.restoreAllMocks();
  });

  it('keeps the original inference through one 502 poll using the same ACK', async () => {
    const f = nativeDeliveryFixture({ steps: [() => new Response('', { status: 502 }),
      () => Response.json({ version: 2, sessionId: f.sessionId, acknowledgedThrough: 1, deliveries: [] })] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.polls.length >= 4 || f.state.closed).toBe(true));
    expect(f.polls).toHaveLength(4);
    expect(f.polls[1]).toEqual(f.polls[2]);
    expect(f.state.executions).toBe(1);
    expect(f.state.signal?.aborted).toBe(false);
    f.release.resolve();
    await vi.waitFor(() => expect(f.replies.some(reply => reply.stream === 'end')).toBe(true));
  });

  it('closes after a second consecutive 502 without starting another inference', async () => {
    const unavailable = () => new Response('', { status: 502 });
    const f = nativeDeliveryFixture({ steps: [unavailable, unavailable] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true));
    expect(f.polls).toHaveLength(3);
    expect(f.state.executions).toBe(1);
    expect(f.state.signal?.aborted).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503, 504])('still closes on HTTP %s', async status => {
    const f = nativeDeliveryFixture({ steps: [() => new Response('', { status })] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true));
    expect(f.polls).toHaveLength(2);
    expect(f.state.executions).toBe(1);
    expect(f.state.signal?.aborted).toBe(true);
  });

  it('source invalidation wins over a 502 response', async () => {
    const f = nativeDeliveryFixture({ steps: [() => { f.state.current = false; return new Response('', { status: 502 }); }] });
    fixtures.push(f); await f.start();
    await vi.waitFor(() => expect(f.state.closed).toBe(true));
    expect(f.polls).toHaveLength(2);
  });

  it.each([false, true])('resends the same reply closure only with reply receipts, enabled=%s', async enabled => {
    const error = new PlanFailure('peer_reply', 'http_error', 502);
    const post = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('same-sequence-ack');
    const reply = sendNativeStreamReply({ enabled, signal: new AbortController().signal, current: () => true, post });
    if (enabled) { expect(await reply).toBe('same-sequence-ack'); expect(post).toHaveBeenCalledTimes(2); }
    else { await expect(reply).rejects.toBe(error); expect(post).toHaveBeenCalledOnce(); }
  });

  it('does not multiply the existing reply budget across different failure kinds', async () => {
    const error = new PlanFailure('peer_reply', 'http_error', 502);
    const post = vi.fn().mockRejectedValueOnce(new PlanFailure('peer_reply', 'timeout', undefined, undefined,
      { phase: 'before_headers' })).mockRejectedValue(error);
    await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(error);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('Cancel during the existing delay prevents retransmission after a 502', async () => {
    const controller = new AbortController();
    const post = vi.fn().mockRejectedValue(new PlanFailure('peer_reply', 'http_error', 502));
    const reply = sendNativeStreamReply({ enabled: true, signal: controller.signal, current: () => true, post });
    // Install rejection handling before cancellation can settle the operation.
    const stopped = expect(reply).rejects.toThrow();
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await stopped; expect(post).toHaveBeenCalledOnce();
  });

  it('does not treat arbitrary errors or coincident security diagnostics as a trusted 502', () => {
    expect(retryableDeliveryFailure({ stage: 'peer_poll', category: 'http_error', httpStatus: 502 }, 'peer_poll')).toBe(false);
    expect(retryableDeliveryFailure(new PlanFailure('peer_capabilities', 'http_error', 502), 'peer_poll')).toBe(false);
    expect(retryableDeliveryFailure(new PlanFailure('peer_poll', 'http_error', 502, undefined,
      { phase: 'before_headers', chromiumCode: 'ERR_CERT_AUTHORITY_INVALID' }), 'peer_poll')).toBe(false);
    expect(retryableDeliveryFailure(new PlanFailure('peer_poll', 'http_error', 502,
      { streamReason: 'body_read' }), 'peer_poll')).toBe(false);
    expect(retryableDeliveryFailure(new PlanFailure('peer_poll', 'http_error', 502), 'peer_reply')).toBe(false);
    expect(retryableDeliveryFailure(Object.assign(new PlanFailure('peer_poll', 'http_error', 502), { cause: new Error('certificate failure') }), 'peer_poll')).toBe(false);
  });
});
