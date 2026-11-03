import { once } from 'node:events';
import { request } from 'node:http';
import { serve } from '@hono/node-server';
import { expect, it } from 'vitest';
import { deliveryFixture, peerRoot, postBody } from './chatgpt-plan-delivery-support.js';

it('keeps an unacknowledged command across an abandoned actual Node HTTP response', async () => {
  const f = await deliveryFixture();
  const app = f.app();
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local test address');
    const url = `http://127.0.0.1:${address.port}${peerRoot}/poll-v2`;
    await f.peers.inferStream(await f.binding(), JSON.stringify({ padding: 'x'.repeat(200000) }), new AbortController().signal);
    const input = { version: 2, sessionId: f.session.sessionId, ackThrough: 0 };
    await new Promise<void>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, timeout: 3000 }, response => {
        response.pause(); req.destroy(); resolve();
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Local test deadline'))); req.end(JSON.stringify(input));
    });
    const replay = await fetch(url, { ...postBody(input), signal: AbortSignal.timeout(3000) });
    expect(replay.status).toBe(200);
    const payload = await replay.json();
    expect(payload.deliveries).toHaveLength(1);
    expect(payload.deliveries[0]).toMatchObject({ deliverySequence: 1, request: { action: 'infer', sequence: 1,
      id: `${f.session.sessionId.slice(0, 24)}000000000001` } });
    expect((await f.peers.observe('owner')).availability).toBe('available');
  } finally {
    await f.close();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
