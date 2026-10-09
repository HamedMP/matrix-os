import { expect, it, vi } from 'vitest';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import type { SitesService } from '../../packages/platform/src/sites/service.js';

const id = '11111111-1111-4111-8111-111111111111';
const edgeSecret = 'verified-edge-proof-secret-1234567890';
const paths = [`/${id}`, `/${id}/frame`, `/${id}/assets/${id}/assets/main.js`, `/${id}/forms/contact`];
function fixture(secret?: string) {
  const resolve = vi.fn();
  const asset = vi.fn(async () => ({ body: Buffer.from('app'), contentType: 'text/javascript' }));
  const admitted = vi.fn();
  const submit = vi.fn();
  const app = createSitePublicRoutes({ service: { resolve, asset, admitted } as unknown as SitesService, edgeSecret: secret, submit });
  return { app, resolve, asset, admitted, submit };
}
function request(path: string, proof?: string) {
  return {
    method: path.includes('/forms/') ? 'POST' : 'GET',
    headers: { ...(proof ? { 'x-matrix-sites-edge': proof } : {}), 'content-type': 'application/json' },
    ...(path.includes('/forms/') ? { body: JSON.stringify({ fields: {}, idempotencyKey: 'valid-submission-key' }) } : {}),
  };
}
it.each([undefined, '', 'short', ' '.repeat(40)])('closes every public route when the edge secret is invalid (%s)', async secret => {
  const { app, resolve, asset, admitted, submit } = fixture(secret);
  for (const path of paths) {
    const response = await app.request(path, request(path, edgeSecret));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Site unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  for (const dependency of [resolve, asset, admitted, submit]) expect(dependency).not.toHaveBeenCalled();
});
it('requires the verified edge proof before reads or form forwarding', async () => {
  const { app, resolve, asset, admitted, submit } = fixture(edgeSecret);
  for (const path of paths) for (const proof of [undefined, 'incorrect-proof']) {
    expect((await app.request(path, request(path, proof))).status).toBe(404);
  }
  for (const dependency of [resolve, asset, admitted, submit]) expect(dependency).not.toHaveBeenCalled();
  const path = paths[2];
  const response = await app.request(path, request(path, edgeSecret));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('app');
  expect(asset).toHaveBeenCalledOnce();
});
