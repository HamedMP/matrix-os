import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientCompatibilityMiddleware } from '../../packages/platform/src/client-compatibility-middleware';
const policy = { latestVersion: '2.0.0', minSupportedVersion: '1.5.0', downloadUrl: 'https://matrix-os.com/download', enforceAfter: '2026-01-01T00:00:00.000Z' };
describe('client API compatibility', () => {
  it('returns an upgrade response for unsupported identified clients, preserving bridge clients and recovery', async () => {
    const app = new Hono();
    app.use('*', clientCompatibilityMiddleware(async () => policy));
    app.get('*', c => c.json({ ok: true }));
    const headers = { 'x-matrix-client-target': 'desktop-macos', 'x-matrix-client-version': '1.0.0' };
    expect((await app.request('/api/apps', { headers })).status).toBe(426);
    expect((await app.request('/api/apps')).status).toBe(200);
    expect((await app.request('/api/system/info', { headers })).status).toBe(200);
    expect((await app.request('/client-policy', { headers })).status).toBe(200);
    expect((await app.request('/api/apps', { headers: { ...headers, 'x-matrix-client-version': '2.0.0' } })).status).toBe(200);
    expect((await app.request('/vm/person/api/apps', { headers })).status).toBe(426);
    expect((await app.request('/api/apps', { headers: { ...headers, 'x-matrix-client-version': 'broken' } })).status).toBe(400);
  });
  it('does not manufacture a minimum version during a policy database outage', async () => {
    const app = new Hono(); app.use('*', clientCompatibilityMiddleware(async () => { throw new Error('database unavailable'); })); app.get('*', c => c.text('ok'));
    expect((await app.request('/api/apps', { headers: { 'x-matrix-client-target': 'mobile-ios', 'x-matrix-client-version': '1.0.0' } })).status).toBe(200);
  });
});
