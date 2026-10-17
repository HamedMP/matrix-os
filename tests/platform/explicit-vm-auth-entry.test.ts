import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { explicitVmAuthReturnTarget } from '../../packages/platform/src/explicit-vm-auth-entry.js';
import { getAuthPage } from '../../packages/platform/src/auth-pages.js';
import { verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';

const DOCUMENT_TARGETS = [
  '/vm/review-machine',
  '/vm/review-machine/projects?runtime=review&view=files&view=recent',
  '/vm/review-machine/~runtime/review/projects?view=files&filter=a%26b',
] as const;

describe('anonymous explicit VM document authentication', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff138',
      clerkUserId: 'user_owner', handle: 'review-machine', runtimeSlot: 'review',
      status: 'running', hetznerServerId: 123482, publicIPv4: '203.0.113.33',
      imageVersion: 'test-host', provisionedAt: '2026-05-25T11:23:51.076Z',
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await destroyTestPlatformDb(db);
  });

  function makeApp(userId?: string, publishableKey: string | undefined = 'pk_test_matrix') {
    const verifyToken = vi.fn().mockResolvedValue({ sub: userId ?? 'user_owner' });
    const orchestrator = stubOrchestrator();
    const app = createApp({
      db, orchestrator, clerkAuth: createClerkAuth({ verifyToken }),
      platformSecret: 'platform-secret-123',
      env: {
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'false',
        PLATFORM_JWT_SECRET: JWT_SECRET,
        AUTH_SHELL_HOST: 'auth-shell.test', AUTH_SHELL_PORT: '3200',
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
      },
    });
    return { app, verifyToken, orchestrator };
  }

  function headers(userId?: string) {
    return {
      host: 'app.matrix-os.com', accept: 'text/html',
      ...(userId ? { authorization: 'Bearer synthetic-clerk-session' } : {}),
    };
  }

  it.each(DOCUMENT_TARGETS)('renders supported sign-in and preserves the full return target: %s', async (target) => {
    // The real Next auth shell has no /vm route. A generic 200 mock hid this defect.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Next route missing', { status: 404 }));
    const { app, verifyToken, orchestrator } = makeApp();
    const response = await app.request(target, { headers: headers() });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-matrix-platform-fallback-auth="true"');
    const embeddedTarget = /var redirectTarget = (.+);/.exec(html)?.[1];
    expect(JSON.parse(embeddedTarget!)).toBe(target);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // Keep the current Main authentication-page script policy after helper extraction.
    expect(response.headers.get('content-security-policy')).toContain('https://www.googletagmanager.com');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
    expect(orchestrator.provision).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it('returns the same sign-in headers without a body for HEAD', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Next route missing', { status: 404 }));
    const { app } = makeApp();
    const response = await app.request(DOCUMENT_TARGETS[2], { method: 'HEAD', headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/vm/review-machine/api/theme', '/vm/review-machine/files/secret.txt',
    '/vm/review-machine/~runtime/review/_next/static/chunk.js',
    '/vm/review-machine/apps/chess/assets/index.js',
    '/vm/review-machine/api/native-apps/sessions/session_aaaaaaaaaaaaaaaaaaaaaaaa/stream/js/Utilities.js',
  ])('does not turn runtime data/assets into a sign-in document: %s', async (target) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Next route missing', { status: 404 }));
    const { app } = makeApp();
    const response = await app.request(target, { headers: headers() });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('mountSignIn');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'POST', accept: 'text/html' },
    { method: 'GET', accept: 'application/json' },
  ])('does not render sign-in for non-document $method / $accept', async ({ method, accept }) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('must not fetch'));
    const { app } = makeApp();
    const response = await app.request(DOCUMENT_TARGETS[0], { method, headers: { ...headers(), accept } });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when sign-in is not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Next route missing', { status: 404 }));
    const { app } = makeApp(undefined, '');
    const response = await app.request(DOCUMENT_TARGETS[0], { headers: headers() });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Matrix OS sign-in unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps authenticated owner routing on the VM with the original non-runtime query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('VM document'));
    const { app } = makeApp('user_owner');
    const response = await app.request(DOCUMENT_TARGETS[2], { headers: headers('user_owner') });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('VM document');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://203.0.113.33:443/projects?view=files&filter=a%26b');
  });

  it('uses a normal app-session cookie as actor identity without diverting a queryless private VM return to primary', async () => {
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    const target = '/vm/pv-2545-1234abcd';
    await insertUserMachine(db, {
      machineId: 'owner-main', clerkUserId: 'user_owner', handle: 'owner-main', runtimeSlot: 'primary',
      status: 'running', publicIPv4: '203.0.113.34', provisionedAt: new Date().toISOString(),
    });
    await insertUserMachine(db, {
      machineId: 'owner-private', clerkUserId: 'user_owner', handle: 'pv-2545-1234abcd',
      runtimeSlot: 'pv-2545-1234abcd', provisioningClass: 'private-preview', sourcePr: 2545,
      confirmedBundleVersion: 'v2026.10.16-pr2545-1-1-abcdef0',
      status: 'running', publicIPv4: '203.0.113.35', provisionedAt: new Date().toISOString(),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Private VM document'));
    const { app } = makeApp('user_owner');
    const entry = await app.request(target, { headers: headers() });
    const html = await entry.text();
    expect(JSON.parse(/var redirectTarget = (.+);/.exec(html)![1])).toBe(target);
    // The existing auth exchange's default slot does not select the explicit VM.
    const exchange = await app.request('/api/auth/app-session', {
      method: 'POST', headers: { ...headers('user_owner'), 'content-type': 'application/json' },
      body: JSON.stringify({ redirectTo: target, runtime: 'primary' }),
    });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toEqual({ redirectTo: target });
    const cookie = exchange.headers.getSetCookie().find(value => value.startsWith('matrix_app_session='))?.split(';')[0];
    expect(cookie).toBeDefined();
    const token = decodeURIComponent(cookie!.slice('matrix_app_session='.length));
    expect(await verifySyncJwt(token, { secret: JWT_SECRET })).toMatchObject({
      sub: 'user_owner', handle: 'owner-main', runtime_slot: 'primary',
    });
    const response = await app.request(target, { headers: { ...headers(), cookie: cookie! } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Private VM document');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://203.0.113.35:443/');
  });

  it.each(['/vm/review-machine', '/vm/missing-machine'])('keeps missing/non-owner targets opaque after authentication: %s', async (target) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('must not fetch'));
    const { app } = makeApp('user_other');
    const response = await app.request(target, { headers: headers('user_other') });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Matrix OS computer unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps ordinary auth-shell routes and their upstream HTTP statuses unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('normal missing shell page', { status: 404 }));
    const { app } = makeApp();
    const response = await app.request('/sign-in', { headers: headers() });
    expect(response.status).toBe(404);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://auth-shell.test:3200/sign-in');
  });

  it('strips credential and auth-return fields but keeps safe repeated query values', async () => {
    const target = '/vm/review-machine/projects?runtime=review&view=files&view=recent&session=synthetic-secret&ACCESS_TOKEN=synthetic-secret&%74oken=synthetic-secret&redirect_url=https%3A%2F%2Fevil.example&device_return=%2Fauth%2Fdevice';
    const { app } = makeApp();
    const response = await app.request(target, { headers: headers() });
    const html = await response.text();
    expect(html).not.toContain('synthetic-secret');
    expect(html).not.toContain('evil.example');
    expect(JSON.parse(/var redirectTarget = (.+);/.exec(html)![1])).toBe(
      '/vm/review-machine/projects?runtime=review&view=files&view=recent',
    );
  });

  it.each(['accessToken', 'refreshToken', 'idToken', 'sessionId', '%61ccessToken', 'code_verifier', 'code-challenge', 'codeChallengeMethod', 'pkce_verifier', 'api_key', 'ApiKey', 'client_secret', '__clerk_db_jwt', 'matrix_asset_token'])('removes canonical auth/PKCE field %s before rendering', async (field) => {
    const { app } = makeApp();
    const response = await app.request(`/vm/review-machine?view=files&${field}=synthetic-secret`, { headers: headers() });
    const html = await response.text();
    expect(html).not.toContain('synthetic-secret');
    expect(JSON.parse(/var redirectTarget = (.+);/.exec(html)![1])).toBe('/vm/review-machine?view=files');
  });

  it.each([
    'https://app.matrix-os.com//evil.example/vm/review-machine',
    'https://app.matrix-os.com/vm/review-machine/../outside',
    'https://app.matrix-os.com/vm/review-machine/%2e%2e/outside',
    'https://app.matrix-os.com/vm/review-machine\\outside',
    'invalid-url',
    `https://app.matrix-os.com/vm/review-machine?view=${'a'.repeat(2_048)}`,
  ])('rejects unsafe or oversized return targets: %s', (target) => {
    expect(explicitVmAuthReturnTarget(target)).toBeNull();
  });

  it('escapes an HTML-breaking query value before embedding the Clerk return', async () => {
    const { app } = makeApp();
    const target = '/vm/review-machine?view=%3C%2Fscript%3E%3Cscript%3Eunsafe%3C%2Fscript%3E';
    const response = await app.request(target, { headers: headers() });
    const html = await response.text();
    expect(html).not.toContain('<script>unsafe</script>');
    expect(JSON.parse(/var redirectTarget = (.+);/.exec(html)![1])).toBe(target);
  });

  it.each([200, 401])('keeps the full safe target and path runtime through natural app-session status %s', async (status) => {
    const target = '/vm/review-machine/~runtime/review/projects?runtime=primary&view=files&filter=a%26b';
    const { app } = makeApp();
    const response = await app.request(target, { headers: headers() });
    const html = await response.text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const replace = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ redirectTo: '/wrong-normalized-target' }, { status }));
    const dom = new JSDOM('<div id="auth"></div>');
    try {
      runInNewContext(script, {
      URL, URLSearchParams, AbortSignal, console,
      document: dom.window.document,
      window: {
        Clerk: { load: async () => undefined, user: {}, session: { getToken: async () => 'synthetic-clerk-token' } },
        location: { href: `https://app.matrix-os.com${target}`, pathname: target.split('?')[0], search: `?${target.split('?')[1]}`, replace },
        sessionStorage: { getItem: () => null },
      },
      fetch: fetchMock,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.waitFor(() => {
        if (status === 200) expect(replace).toHaveBeenCalledWith(target);
        else expect(dom.window.document.getElementById('auth')?.textContent).toContain('Session needs a refresh');
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/app-session');
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ redirectTo: target, runtime: 'review' });
      if (status !== 200) expect(replace).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });

  it('keeps ordinary root recovery following the existing app-session redirect', async () => {
    const html = getAuthPage('pk_test_matrix', 'sign-in', 'synthetic-nonce', '/', 'https://app.matrix-os.com');
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const replace = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ redirectTo: '/runtime' }));
    const dom = new JSDOM('<div id="auth"></div>');
    try {
      runInNewContext(script, {
        URL, URLSearchParams, AbortSignal, console, document: dom.window.document,
        window: {
          Clerk: { load: async () => undefined, user: {}, session: { getToken: async () => 'synthetic-clerk-token' } },
          location: { href: 'https://app.matrix-os.com/', pathname: '/', search: '', replace },
          sessionStorage: { getItem: () => null },
        },
        fetch: fetchMock,
      });
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/runtime'));
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ redirectTo: '/' });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { dom.window.close(); }
  });
});
