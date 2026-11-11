import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { bootstrapDevstackIdentity } from '../../packages/platform/src/devstack-bootstrap.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const owner = 'user_devstack_fixture';
const instance = 'fixture';
const handle = 'devstack-fixture';
const target = 'https://app.matrix-os.com/runtime';
const previewHost = 'app.localhost';
const previewOrigin = `https://${previewHost}`;

describe('registered DevStack account computer manager', () => {
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await bootstrapDevstackIdentity(db, {
      instance,
      handle,
      clerkUserId: owner,
      email: 'devstack@example.com',
      containerId: 'a'.repeat(64),
      gatewayPort: 4000,
      shellPort: 3000,
    });
    app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      registeredRuntimeInstance: instance,
      env: {
        MATRIX_APP_ORIGIN: previewOrigin,
        MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
      },
      clerkAuth: createClerkAuth({
        async verifyToken(token) {
          return { sub: token === 'owner-session' ? owner : 'user_other' };
        },
      }),
      platformSecret: 'fixture-only-platform-secret',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.shutdownPostHog();
    await destroyTestPlatformDb(db);
  });

  it.each([
    ['GET', '/runtime'],
    ['HEAD', '/runtime'],
    ['GET', `/vm/${handle}/runtime`],
  ])('sends an authenticated owner from %s %s to the canonical manager', async (method, path) => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No auth shell'));
    const response = await app.request(`${previewOrigin}${path}?return_to=https://outside.invalid/&runtime=primary&new=1`, {
      method,
      headers: { host: previewHost, cookie: '__session=owner-session' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(target);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets an unsigned browser sign in on the canonical account manager', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No auth shell'));
    const response = await app.request(`${previewOrigin}/runtime`, {
      headers: { host: previewHost },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(target);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [`/vm/${handle}/runtime`, '', 401],
    ['/runtime', 'other-session', 404],
    [`/vm/${handle}/runtime`, 'other-session', 404],
    ['/vm/other-runtime/runtime', 'owner-session', 404],
  ])('requires the registered owner for %s with session %s', async (path, session, status) => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No auth shell'));
    const response = await app.request(`${previewOrigin}${path}`, {
      headers: { host: previewHost, ...(session ? { cookie: `__session=${session}` } : {}) },
    });

    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects mutation requests before reaching the account manager', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No auth shell'));
    const response = await app.request(`${previewOrigin}/runtime`, {
      method: 'POST',
      headers: { host: previewHost, cookie: '__session=owner-session' },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(response.headers.get('location')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });
});
