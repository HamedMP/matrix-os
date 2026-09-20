import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createInternalIntegrationGuard } from '../../packages/platform/src/internal-integration-guard.js';

function setup() {
  const guard = createInternalIntegrationGuard();
  const app = new Hono();
  app.use('*', (c, next) => { c.set('internalContainerHandle', c.req.header('test-handle')!); return next(); });
  app.use('*', guard.middleware);
  let calls = 0;
  app.post('/call', (c) => { calls++; return c.json({ ok: true }); });
  const request = (handle: string, action = 'symphony_poll') => app.request('/call', {
    method: 'POST', headers: { 'content-type': 'application/json', 'test-handle': handle },
    body: JSON.stringify({ service: 'linear', action }),
  });
  return { guard, request, calls: () => calls };
}

describe('internal integration admission before owner DB lookup', () => {
  it('rejects 100 legacy runtimes over repeated five-second-equivalent waves without downstream calls', async () => {
    const { request, calls } = setup();
    for (let wave = 0; wave < 12; wave++) {
      const responses = await Promise.all(Array.from({ length: 100 }, (_, n) => request(`owner-${n}`, 'graphql')));
      expect(responses.every(r => r.status === 410)).toBe(true);
    }
    expect(calls()).toBe(0);
  });
  it('bounds a synchronized fleet burst and returns retry guidance', async () => {
    const { request, calls, guard } = setup();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, n) => request(`owner-${n}`)));
    expect(calls()).toBeLessThanOrEqual(8);
    expect(responses.filter(r => r.status === 429).length).toBeGreaterThanOrEqual(92);
    expect(responses.find(r => r.status === 429)!.headers.get('Retry-After')).toBe('60');
    expect(guard.snapshot().inFlight).toBe(0);
  });
});
