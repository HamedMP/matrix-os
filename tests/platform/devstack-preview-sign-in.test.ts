import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { bootstrapDevstackIdentity } from '../../packages/platform/src/devstack-bootstrap.js';
import { createApp } from '../../packages/platform/src/main.js';
import { APP_SESSION_COOKIE, CODE_SESSION_COOKIE } from '../../packages/platform/src/session-cookies.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubDocker, stubOrchestrator } from './proxy-routing-test-utils.js';

const HOST = 'app.matrix-os.com';
const INSTANCE = 'sign-in-fixture';
const HANDLE = 'devstack-sign-in-fixture';
const OWNER = 'user_devstack_owner';
const ROOT = `/vm/${HANDLE}/`;
const SIGN_IN = `/sign-in?redirect_url=${encodeURIComponent(ROOT)}`;
const KEY = 'pk_test_devstack_sign_in_fixture';
const OWNER_COOKIE = '__session=fixture-owner-session';
const OTHER_COOKIE = '__session=fixture-other-session';

describe('registered DevStack preview sign-in', () => {
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;
  const request = (target: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('host', HOST);
    return app.request(`https://${HOST}${target}`, { ...init, headers });
  };
  const orchestrator = stubOrchestrator();
  const docker = stubDocker();
  const clerkAuth = createClerkAuth({
    async verifyToken(token) {
      if (token === 'fixture-owner-session') return { sub: OWNER };
      if (token === 'fixture-other-session') return { sub: 'user_devstack_other' };
      throw new Error('Invalid fixture session');
    },
  });
  const env = {
    PLATFORM_RUNTIME_MODE: 'local',
    MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await app?.shutdownPostHog();
    await destroyTestPlatformDb(db);
  });

  it('redirects anonymous preview GET and HEAD before requiring the Clerk publishable key', async () => {
    app = createApp({ db, orchestrator, clerkAuth, env, registeredRuntimeInstance: INSTANCE });
    for (const method of ['GET', 'HEAD']) {
      const res = await request(ROOT, { method });
      expect.soft(res.status).toBe(302);
      expect.soft(res.headers.get('location')).toBe(SIGN_IN);
      expect.soft(res.headers.get('cache-control')).toContain('no-store');
    }
    const unavailable = await request(SIGN_IN);
    expect.soft(unavailable.status).toBe(503);
    expect.soft(unavailable.headers.get('cache-control')).toContain('no-store');
    expect(orchestrator.provision).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it('serves Clerk sign-in, then returns the verified owner to the same registered preview', async () => {
    await bootstrapDevstackIdentity(db, {
      instance: INSTANCE, clerkUserId: OWNER, handle: HANDLE, email: 'owner@example.test',
      displayName: 'Preview owner', containerId: 'a'.repeat(64), gatewayPort: 4000, shellPort: 3000,
    });
    app = createApp({
      db, docker, orchestrator, clerkAuth, registeredRuntimeInstance: INSTANCE,
      env: { ...env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: KEY },
    });
    const fetchUpstream = vi.fn(async (url: string) => {
      if (url !== `http://matrixos-${HANDLE}:3000/`) throw new Error('Unexpected preview upstream');
      return new Response('registered preview shell');
    });
    vi.stubGlobal('fetch', fetchUpstream);

    const login = await request(SIGN_IN);
    expect.soft(login.status).toBe(200);
    expect.soft(login.headers.get('cache-control')).toContain('no-store');
    expect.soft(login.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await login.text();
    expect.soft(html).toContain(`data-clerk-publishable-key="${KEY}"`);
    expect.soft(html).toContain(`var redirectTarget = "${ROOT}";`);
    expect.soft(html).toContain('forceRedirectUrl: redirectTarget');
    expect.soft(html).toContain("routing: 'hash'");
    expect.soft(html).not.toContain('/api/auth/app-session');
    expect.soft(fetchUpstream).not.toHaveBeenCalled();

    const owner = { headers: { cookie: OWNER_COOKIE } };
    const signedIn = await request(SIGN_IN, owner);
    expect.soft(signedIn.status).toBe(302);
    expect.soft(signedIn.headers.get('location')).toBe(ROOT);
    expect.soft(signedIn.headers.get('cache-control')).toContain('no-store');
    const preview = await request(signedIn.headers.get('location') ?? ROOT, owner);
    expect.soft(preview.status).toBe(200);
    expect.soft(await preview.text()).toBe('registered preview shell');

    const other = { headers: { cookie: OTHER_COOKIE } };
    const denied = await request(ROOT, other);
    expect.soft(denied.status).toBe(404);
    expect.soft(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(orchestrator.provision).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it('stops the preview sign-in loop when older Matrix sessions conflict with Clerk or have a stale route', async () => {
    await bootstrapDevstackIdentity(db, {
      instance: INSTANCE, clerkUserId: OWNER, handle: HANDLE, email: 'owner@example.test',
      displayName: 'Preview owner', containerId: 'a'.repeat(64), gatewayPort: 4000, shellPort: 3000,
    });
    app = createApp({
      db, orchestrator, clerkAuth, registeredRuntimeInstance: INSTANCE,
      env: { ...env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: KEY },
    });
    const issueSession = async (handle: string) => (await issueSyncJwt({
      secret: JWT_SECRET, clerkUserId: OWNER, handle, gatewayUrl: `https://${HOST}`,
    })).token;
    const validToken = await issueSession(HANDLE);
    const staleToken = await issueSession('old-preview-handle');
    for (const cookie of [
      `${APP_SESSION_COOKIE}=${validToken}; ${OTHER_COOKIE}`,
      `${APP_SESSION_COOKIE}=${staleToken}; ${OWNER_COOKIE}`,
      `${CODE_SESSION_COOKIE}=${staleToken}; ${OWNER_COOKIE}`,
    ]) {
      const browser = { headers: { cookie } };
      const preview = await request(ROOT, browser);
      expect(preview.status).toBe(302);
      expect(preview.headers.get('location')).toBe(SIGN_IN);
      const login = await request(SIGN_IN, browser);
      expect.soft(login.status).toBe(409);
      expect.soft(login.headers.get('location')).toBeNull();
      expect.soft(login.headers.get('cache-control')).toContain('no-store');
      expect.soft(await login.text()).toContain('private browser window');
    }

    for (const cookie of [
      `${APP_SESSION_COOKIE}=${validToken}; ${OWNER_COOKIE}`,
      `${APP_SESSION_COOKIE}=invalid-stale-token; ${OTHER_COOKIE}`,
    ]) {
      const allowed = await request(SIGN_IN, { headers: { cookie } });
      expect.soft(allowed.status).toBe(302);
      expect.soft(allowed.headers.get('location')).toBe(ROOT);
    }
  });

  it('rejects unsafe or duplicate return paths without redirecting, even with a Clerk cookie', async () => {
    app = createApp({
      db, orchestrator, clerkAuth, registeredRuntimeInstance: INSTANCE,
      env: { ...env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: KEY },
    });
    const unsafeTargets = [
      '', `https://${HOST}${ROOT}`, '//outside.invalid/', '/\\outside.invalid/',
      '/vm/%64evstack-sign-in-fixture/', `${ROOT}../`, `${ROOT}api/private`,
      `${ROOT}?runtime=preview`, `${ROOT}#return`, `${ROOT}\n`, '/vm/devstack-sign-in-fixture\n/',
    ];
    const invalid = [
      ...unsafeTargets.map(target => `/sign-in?redirect_url=${encodeURIComponent(target)}`),
      `${SIGN_IN}&%72edirect_url=${encodeURIComponent(ROOT)}`,
    ];
    for (const target of invalid) {
      const res = await request(target, { headers: { cookie: OWNER_COOKIE } });
      expect.soft(res.status, target).toBe(400);
      expect.soft(res.headers.get('location'), target).toBeNull();
      expect.soft(res.headers.get('cache-control'), target).toContain('no-store');
    }
  });

  it('preserves anonymous registered API and WebSocket HTTP auth responses', async () => {
    app = createApp({ db, orchestrator, clerkAuth, env, registeredRuntimeInstance: INSTANCE });
    for (const suffix of ['api/system/info', 'ws']) {
      const res = await request(ROOT + suffix);
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('keeps normal Platform preview auth behavior', async () => {
    app = createApp({
      db, orchestrator, clerkAuth,
      env: { ...env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: KEY },
    });
    const res = await request(ROOT);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('/api/auth/app-session');
  });
});
