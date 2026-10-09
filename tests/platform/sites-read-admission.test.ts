import { afterEach, expect, it, vi } from 'vitest';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import type { SitesService } from '../../packages/platform/src/sites/service.js';
const id = '11111111-1111-4111-8111-111111111111';
const path = `/${id}/assets/${id}/assets/main.js`;
function fixture() {
  const asset = vi.fn(async () => ({ body: Buffer.from('app'), contentType: 'text/javascript' }));
  const app = createSitePublicRoutes({ service: { asset } as unknown as SitesService, edgeSecret: 'verified-edge-proof-secret-1234567890', submit: async () => ({ accepted: true }) });
  const request = (source = 'visitor') => app.request(path, { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890', 'x-matrix-sites-source': source } });
  return { asset, request };
}
afterEach(() => vi.useRealTimers());
it('caps anonymous reads before storage and holds admission until body consumption or cancellation', async () => {
  const { asset, request } = fixture();
  const responses = await Promise.all(Array.from({ length: 16 }, () => request()));
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect((await request()).status).toBe(429);
  expect(asset).toHaveBeenCalledTimes(16);
  expect(await responses[0].text()).toBe('app');
  const next = await request(); expect(next.status).toBe(200);
  expect((await request()).status).toBe(429);
  await next.body!.cancel();
  const afterCancel = await request(); expect(afterCancel.status).toBe(200);
  await Promise.all([...responses.slice(1), afterCancel].map(response => response.body!.cancel()));
});
it('expires stalled response bodies after a bounded transfer deadline', async () => {
  vi.useFakeTimers();
  const { request } = fixture();
  const responses = await Promise.all(Array.from({ length: 16 }, () => request()));
  expect((await request()).status).toBe(429);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(responses[0].text()).rejects.toThrow('Site unavailable');
  const next = await request(); expect(next.status).toBe(200); await next.body!.cancel();
});
it('bounds bursts by the verified edge source without trusting direct identity headers', async () => {
  const { asset, request } = fixture();
  for (let index = 0; index < 1200; index++) { const response = await request(); expect(response.status).toBe(200); await response.body!.cancel(); }
  expect((await request()).status).toBe(429); expect(asset).toHaveBeenCalledTimes(1200);
  const other = await request('other-visitor'); expect(other.status).toBe(200); await other.body!.cancel();
});
