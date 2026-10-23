import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryFixture, peerRoot, postBody } from './chatgpt-plan-delivery-support.js';

describe('retained Native command delivery through actual Host routes', () => {
  const fixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = [];
  afterEach(async () => { for (const f of fixtures) f.peers.close(); vi.useRealTimers(); for (const f of fixtures.splice(0)) await f.close(); });
  it('redelivers the original unacknowledged infer after the first response is lost', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const app = f.app();
    const input = { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
    const first = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(first.status).toBe(200);
    const lost = await first.json(); // Discard the real payload without handling/ACK.
    const next = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual(lost);
    expect(lost).toMatchObject({ version: 2, acknowledgedThrough: 0, deliveries: [
      { deliverySequence: 1, request: { action: 'infer', sequence: 1, body: '{}' } },
    ] });
  });
  it('retains a lost Cancel even after its inference leaves pending', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    const stop = new AbortController();
    await f.peers.inferStream(await f.binding(), '{}', stop.signal);
    const app = f.app(), input = { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
    const first = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(first.status).toBe(200);
    const original = (await first.json()).deliveries[0].request;
    stop.abort();
    const second = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    const lost = await second.json();
    expect(lost.deliveries).toEqual([
      { deliverySequence: 1, request: original },
      { deliverySequence: 2, request: { version: 1, action: 'cancel', id: original.id } },
    ]);
    const replay = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(await replay.json()).toEqual(lost);
  });
  it('prunes only an ACKed prefix and accepts the same ACK again after its response is lost', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const app = f.app(), input = { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
    const first = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(first.status).toBe(200); await first.json();
    await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const acked = await app.request(`${peerRoot}/poll-v2`, postBody({ ...input, ackThrough: 1 }));
    const lost = await acked.json();
    expect(lost).toMatchObject({ acknowledgedThrough: 1, deliveries: [{ deliverySequence: 2, request: { sequence: 2 } }] });
    const repeat = await app.request(`${peerRoot}/poll-v2`, postBody({ ...input, ackThrough: 1 }));
    expect(await repeat.json()).toEqual(lost);
    expect((await app.request(`${peerRoot}/poll-v2`, postBody(input))).status).toBe(409);
    expect((await app.request(`${peerRoot}/poll-v2`, postBody({ ...input, ackThrough: 3 }))).status).toBe(409);
  });
  it('does not renew a v2 lease when a rejected legacy poll tries to downgrade it', async () => {
    let now = 100000;
    const f = await deliveryFixture(() => now); fixtures.push(f);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const empty = f.peers.pollV2('owner', { version: 2, sessionId: f.session.sessionId, ackThrough: 0 }, new AbortController().signal);
    now += 10000; await vi.advanceTimersByTimeAsync(10000); (await empty).release();
    now += 29000;
    await expect(f.peers.poll('owner', f.session)).rejects.toThrow('conflict');
    now += 2000;
    expect((await f.peers.observe('owner')).availability).toBe('unavailable');
  });
  it.each(['infer', 'inferStream'] as const)('does not publish an orphan Cancel when %s is aborted across awaited admission', async method => {
    let now = 100000;
    const f = await deliveryFixture(() => now); fixtures.push(f);
    const binding = await f.binding();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = f.peers.pollV2('owner', { version: 2, sessionId: f.session.sessionId, ackThrough: 0 }, new AbortController().signal);
    const stop = new AbortController(), inference = f.peers[method](binding, '{}', stop.signal);
    stop.abort(); await expect(inference).rejects.toThrow('unavailable');
    now += 10000; await vi.advanceTimersByTimeAsync(10000);
    const emission = await pending;
    try { expect(JSON.parse(new TextDecoder().decode(emission.encoded)).deliveries).toEqual([]); }
    finally { emission.release(); }
  });
});
