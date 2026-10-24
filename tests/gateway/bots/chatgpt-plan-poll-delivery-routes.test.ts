import { afterEach, describe, expect, it } from 'vitest';
import { deliveryFixture, peerRoot, postBody } from './chatgpt-plan-delivery-support.js';

describe('session-bound Native command delivery routes', () => {
  const fixtures: Awaited<ReturnType<typeof deliveryFixture>>[] = [];
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
  it('advertises receipt-ACK delivery only for the exact enrolled owner session', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    const response = await f.app().request(`${peerRoot}/capabilities`, postBody(f.session));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...f.session, pollDeliveryVersion: 2 });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects actual oversized capability bytes even when Content-Length understates them', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    const request = postBody(f.session);
    request.headers = { ...request.headers, 'content-length': '1' };
    request.body = String(request.body) + ' '.repeat(513);
    const response = await f.app().request(`${peerRoot}/capabilities`, request);
    expect(response.status).toBe(413);
  });
  it('retains only two unfinished application emissions, releasing a canceled response without dropping its session', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    await f.peers.inferStream(await f.binding(), JSON.stringify({ padding: 'x'.repeat(200000) }), new AbortController().signal);
    const app = f.app(), input = { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
    const first = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(first.status).toBe(200);
    const second = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(second.status).toBe(200);
    expect((await app.request(`${peerRoot}/poll-v2`, postBody(input))).status).toBe(409);
    await first.body!.cancel();
    const recovered = await app.request(`${peerRoot}/poll-v2`, postBody(input));
    expect(recovered.status).toBe(200);
    const expected = await second.json();
    expect(await recovered.json()).toEqual(expected);
  });
  it('keeps owner, Native bearer, strict DTO and preparse body boundaries on both new endpoints', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    for (const path of ['capabilities', 'poll-v2']) {
      const body = path === 'capabilities' ? f.session : { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
      for (const app of [f.app('other'), f.app('owner', 'dev-default'), f.app('owner', 'jwt', false)]) {
        expect((await app.request(`${peerRoot}/${path}`, postBody(body))).status).toBe(403);
      }
      expect((await f.app().request(`${peerRoot}/${path}`, postBody(body, false))).status).toBe(403);
      expect((await f.app().request(`${peerRoot}/${path}`, postBody({ ...body, unrelated: true }))).status).toBe(400);
      expect((await f.app().request(`${peerRoot}/${path}`, postBody({ ...body, sessionId: '20000000-0000-4000-8000-000000000001' }))).status).toBe(503);
      expect((await f.app().request(`${peerRoot}/${path}`, postBody({ padding: 'x'.repeat(513) }))).status).toBe(413);
    }
  });
  it('does not renew the peer lease by querying capabilities', async () => {
    let now = 100000;
    const f = await deliveryFixture(() => now); fixtures.push(f);
    now += 29000;
    expect((await f.app().request(`${peerRoot}/capabilities`, postBody(f.session))).status).toBe(200);
    now += 2000;
    expect((await f.peers.observe('owner')).availability).toBe('unavailable');
  });
  it('does not let one queued response chunk pin its entire published encoding after slot release', async () => {
    const f = await deliveryFixture(); fixtures.push(f);
    await f.peers.inferStream(await f.binding(), JSON.stringify({ padding: 'x'.repeat(200000) }), new AbortController().signal);
    const response = await f.app().request(`${peerRoot}/poll-v2`, postBody({ version: 2, sessionId: f.session.sessionId, ackThrough: 0 }));
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(first.value!.byteLength).toBeLessThanOrEqual(65536);
      expect(first.value!.buffer.byteLength).toBeLessThanOrEqual(65536);
    } finally { await reader.cancel(); }
  });
});
