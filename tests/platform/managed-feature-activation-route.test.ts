import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createCustomerVpsRoutes } from '../../packages/platform/src/customer-vps-routes.js';
import { PreviewRuntimeAccessError } from '../../packages/platform/src/preview-runtime-access.js';

describe('managed feature operator activation', () => {
  const secret = 'platform-operator-test-secret';
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const page = { activated: 8, failed: 0, complete: false, nextCursor: '12345678-1234-4234-8234-123456789abc' };
  function app(activate = vi.fn(async () => page)) {
    return { activate, routes: new Hono().route('/vps', createCustomerVpsRoutes({ platformSecret: secret,
      service: {} as Parameters<typeof createCustomerVpsRoutes>[0]['service'], activateManagedFeatures: activate })) };
  }
  it('authenticates, bounds and validates operator requests before dispatch', async () => {
    const { routes, activate } = app();
    const path = '/vps/managed-features/activate';
    expect((await routes.request(path, { method: 'POST', body: '{}' })).status).toBe(401);
    for (const body of ['{"handle":"../bad"}', '{"origin":"https://evil.example"}', '{"handle":"alice","afterMachineId":"12345678-1234-4234-8234-123456789abc"}', 'invalid']) {
      expect((await routes.request(path, { method: 'POST', headers, body })).status).toBe(400);
    }
    expect((await routes.request(path, { method: 'POST', headers, body: 'x'.repeat(5000) })).status).toBe(413);
    expect(activate).not.toHaveBeenCalled();
    const response = await routes.request(path, { method: 'POST', headers, body: JSON.stringify({ afterMachineId: page.nextCursor }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(activate).toHaveBeenCalledWith({ afterMachineId: page.nextCursor });
  });
  it('reports missing dependencies and service failures truthfully', async () => {
    const { routes } = app(vi.fn(async () => { throw new Error('database path credentials'); }));
    const response = await routes.request('/vps/managed-features/activate', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('database path credentials');
    const missing = new Hono().route('/vps', createCustomerVpsRoutes({ platformSecret: secret, service: {} as never }));
    expect((await missing.request('/vps/managed-features/activate', { method: 'POST', headers, body: '{}' })).status).toBe(503);
  });
});

describe('Preview runtime access activation route', () => {
  const secret = 'platform-operator-test-secret';
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const body = JSON.stringify({ ownerId: 'user_preview', machineId: '71cf5b5b-f624-4c1c-9b6c-4dd2d46b2b02',
    runtimeSlot: 'pr-2383', expectedRuntimeTokenEpoch: 1 });
  function routes(activate: () => Promise<never>) {
    return new Hono().route('/vps', createCustomerVpsRoutes({ platformSecret: secret,
      service: {} as Parameters<typeof createCustomerVpsRoutes>[0]['service'],
      activatePreviewRuntimeAccess: activate as never }));
  }
  it.each([
    ['ineligible', 'preview_access_ineligible'],
    ['identity_mismatch', 'preview_access_ineligible'],
    ['policy_conflict', 'preview_access_ineligible'],
  ] as const)('returns a non-retryable 409 for %s without leaking the cause', async (cause, code) => {
    const response = await routes(async () => { throw new PreviewRuntimeAccessError(cause); })
      .request('/vps/preview/access/activate', { method: 'POST', headers, body });
    expect(response.status).toBe(409);
    const payload = await response.json() as { error: string; code: string };
    expect(payload.code).toBe(code);
    expect(payload.error).toBe('Preview access is not eligible');
    expect(JSON.stringify(payload)).not.toMatch(/runtime|allocation|funded policy/i);
  });
  it('keeps unavailable (global policy off, revision race, expiry boundary) retryable as 503', async () => {
    const response = await routes(async () => { throw new PreviewRuntimeAccessError('unavailable'); })
      .request('/vps/preview/access/activate', { method: 'POST', headers, body });
    expect(response.status).toBe(503);
  });
  it('keeps transient host activation failures retryable as generic 503s', async () => {
    const response = await routes(async () => { throw new Error('203.0.113.10 refused connection'); })
      .request('/vps/preview/access/activate', { method: 'POST', headers, body });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('203.0.113.10');
  });
});
