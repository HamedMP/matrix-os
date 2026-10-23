import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { Hono } from 'hono';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { issueSyncJwt, verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { buildPlatformUserProof } from '../../packages/platform/src/session-routing-websocket.js';
import { APP_SESSION_COOKIE, CODE_SESSION_COOKIE } from '../../packages/platform/src/session-cookies.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator, JWT_SECRET } from './proxy-routing-test-utils.js';
import { insertContainer, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';

const clerkKey = new TextEncoder().encode('fictional-clerk-signature-key-32-characters');
const env = { MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: 'user_pilotA', PLATFORM_JWT_SECRET: JWT_SECRET };
async function clerkToken(sub: string) {
  return new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(clerkKey);
}
const clerkAuth = createClerkAuth({ verifyToken: async token => {
  const { payload } = await jwtVerify(token, clerkKey, { algorithms: ['HS256'] });
  return { ...payload, sub: payload.sub! };
} });
async function syncToken(sub: string) {
  return (await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: sub, handle: 'pilot', gatewayUrl: 'https://example.invalid', sessionProvenance: 'clerk-device' })).token;
}

describe('app-wide pilot identity admission', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.unstubAllEnvs(); });
  function app(override = env) {
    const callbacks = new Hono().get('/gmail/oauth/callback', c => c.json({ independentlyAuthenticated: true }))
      .post('/gmail/pipedream/callback', c => c.json({ independentlyAuthenticated: true }));
    return createApp({ db, orchestrator: stubOrchestrator(), clerkAuth, env: override,
      platformSecret: 'fictional-platform-secret', integrationRoutes: callbacks });
  }
  it('refuses genuinely signed nonmembers before session exchange, provisioning, owner HTTP and arbitrary Host routing', async () => {
    const token = await clerkToken('user_outside');
    const a = app();
    for (const [method, path] of [['POST', '/api/auth/app-session'], ['POST', '/api/auth/provision-runtime'], ['GET', '/api/me'], ['GET', '/api/integrations/connections'], ['GET', '/vps/machines']]) {
      for (const host of ['app.matrix-os.com', 'code.matrix-os.com', 'unlisted.invalid']) {
        const response = await a.request(path, { method, headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(response.status, `${method} ${host}${path}`).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ error: 'Access unavailable' });
      }
    }
  });
  it('refuses already signed Matrix native, browser and code sessions even without a Clerk cookie', async () => {
    const token = await syncToken('user_outside');
    const a = app();
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: `${APP_SESSION_COOKIE}=${token}` }, { cookie: `${CODE_SESSION_COOKIE}=${token}` }]) {
      const response = await a.request('/api/me', { headers: { host: 'app.matrix-os.com', ...headers } });
      expect(response.status).toBe(403);
    }
  });
  it('preserves exact callback capabilities and anonymous health/device issuance, without broad callback-prefix exemptions', async () => {
    const a = app();
    const headers = { host: 'app.matrix-os.com', cookie: `__session=${await clerkToken('user_outside')}` };
    expect((await a.request('/health')).status).toBe(200);
    expect((await a.request('/api/auth/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'matrix-os-desktop' }) })).status).toBe(200);
    // Production handlers still perform stored-state / attempt-secret validation;
    // these sentinels prove only that the app-wide gate preserves exact dispatch.
    expect((await a.request('/api/integrations/gmail/oauth/callback?state=opaque', { headers })).status).toBe(200);
    expect((await a.request('/api/integrations/gmail/pipedream/callback', { method: 'POST', headers })).status).toBe(200);
    expect((await a.request('/api/integrations/gmail/oauth/callback/extra', { headers })).status).toBe(403);
    expect((await a.request('/api/integrations/gmail/oauth/callback', { method: 'POST', headers })).status).toBe(403);
    expect((await a.request('/api/integrations/gmail/pipedream/callback', { headers })).status).toBe(403);
  });
  it('rejects a stored approval for a nonmember at the actual native token issuance boundary', async () => {
    const a = app();
    const codeResponse = await a.request('/api/auth/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'matrix-os-desktop' }) });
    const code = await codeResponse.json();
    await db.executor.updateTable('device_codes').set({ clerk_user_id: 'user_outside', runtime_handle: 'pilot' }).where('device_code', '=', code.deviceCode).execute();
    const response = await a.request('/api/auth/device/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: code.deviceCode }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Access unavailable' });
  });
  it('denies native approval to a verified nonmember before interpreting the form', async () => {
    const response = await app().request('/auth/device/approve', { method: 'POST', headers: { authorization: `Bearer ${await clerkToken('user_outside')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'userCode=AAAA-BBBB&csrf=fictional' });
    expect(response.status).toBe(403);
  });
  it('never upgrades a transient first verification refusal into nonmember session issuance', async () => {
    await insertContainer(db, { handle: 'pilot', clerkUserId: 'user_outside', containerId: 'fictional', port: 5001, shellPort: 6001, status: 'running' });
    const verify = vi.fn().mockResolvedValueOnce({ authenticated: false }).mockResolvedValue({ authenticated: true, userId: 'user_outside' });
    const a = createApp({ db, orchestrator: stubOrchestrator(), env, clerkAuth: { ...clerkAuth, verify } });
    const response = await a.request('/api/auth/app-session', { method: 'POST', headers: { host: 'app.matrix-os.com', authorization: `Bearer ${await clerkToken('user_outside')}`, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('issues native tokens for approved cohort actors and forwards their cryptographic actor proof', async () => {
    await insertUserMachine(db, { machineId: 'fictional-pilot-machine', handle: 'pilot', clerkUserId: 'user_pilotA', runtimeSlot: 'primary', status: 'running', publicIPv4: '203.0.113.20', provisionedAt: '2026-10-23T00:00:00.000Z' });
    const a = app();
    const code = await (await a.request('/api/auth/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'matrix-os-desktop' }) })).json();
    const approval = await a.request('/auth/device/approve', { method: 'POST', headers: {
      authorization: `Bearer ${await clerkToken('user_pilotA')}`, cookie: 'device_csrf=fictional-csrf', 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ userCode: code.userCode, csrf: 'fictional-csrf' }).toString() });
    expect(approval.status).toBe(200);
    const response = await a.request('/api/auth/device/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: code.deviceCode }) });
    expect(response.status).toBe(200);
    const issued = await response.json();
    expect((await verifySyncJwt(issued.accessToken, { secret: JWT_SECRET })).sub).toBe('user_pilotA');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('pilot shell'));
    try {
      expect((await a.request('/vm/pilot/', { headers: { host: 'app.matrix-os.com', authorization: `Bearer ${issued.accessToken}`, 'x-platform-user-id': 'user_forged', 'x-platform-verified': 'forged' } })).status).toBe(200);
      const forwarded = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(forwarded.get('x-platform-user-id')).toBe('user_pilotA');
      expect(forwarded.get('x-platform-verified')).toBe(buildPlatformUserProof('pilot', 'user_pilotA', 'fictional-platform-secret'));
    } finally { fetchMock.mockRestore(); }
  });
  it('lets a verified cohort actor reach the existing owner handler and preserves default-disabled behavior', async () => {
    await insertContainer(db, { handle: 'pilot', clerkUserId: 'user_pilotA', containerId: 'fictional', port: 5001, shellPort: 6001, status: 'running' });
    const a = app();
    expect((await a.request('/api/me', { headers: { authorization: `Bearer ${await syncToken('user_pilotA')}` } })).status).toBe(200);
    await db.executor.updateTable('containers').set({ clerk_user_id: 'user_outside' }).where('handle', '=', 'pilot').execute();
    const disabled = app({ ...env, MATRIX_PILOT_ACCESS_ENABLED: 'false' });
    expect((await disabled.request('/api/me', { headers: { authorization: `Bearer ${await syncToken('user_outside')}` } })).status).toBe(200);
  });
  it('refuses startup with enabled empty or malformed policy', () => {
    expect(() => app({ ...env, MATRIX_PILOT_ALLOWED_CLERK_IDS: '' })).toThrow('Pilot access configuration unavailable');
  });
  it('refuses an enabled pilot without a Clerk verifier', () => {
    expect(() => createApp({ db, orchestrator: stubOrchestrator(), env })).toThrow('Pilot access configuration unavailable');
  });
});
