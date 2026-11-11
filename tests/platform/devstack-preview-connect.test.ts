import { describe, expect, it, vi } from 'vitest';
import { bootstrapDevstackIdentity } from '../../packages/platform/src/devstack-bootstrap.js';
import { resolveRegisteredRuntimeEndpoint } from '../../packages/platform/src/devstack-registered-runtime.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { createDevstackPreviewRoutes } from '../../packages/platform/src/devstack-preview-routes.js';

const origin = 'https://devstack.example.test';
const issuer = 'https://clerk.example.test';
const owner = 'user_preview_owner';
const other = 'user_preview_other';
const first = {
  runtime: 'first', worktree: 'feature-one', owner, handle: 'dev-one', containerId: 'a'.repeat(64),
};
const second = {
  runtime: 'second', worktree: 'feature-two', owner, handle: 'dev-two', containerId: 'b'.repeat(64),
};
const hidden = {
  runtime: 'other', worktree: 'feature-other', owner: other, handle: 'dev-other', containerId: 'c'.repeat(64),
};
const previewConfig = { issuer, previewOrigin: origin, operators: [owner, other], targets: [first, second, hidden] };

function fixture(targets = previewConfig.targets) {
  const config = loadDevstackPreviewConfig(JSON.stringify({ ...previewConfig, targets }), 'stage-three')!;
  const clerkAuth = createClerkAuth({
    async verifyToken(token) {
      if (!['owner', 'other', 'restricted'].includes(token)) throw new Error('Invalid fixture');
      return {
        sub: token === 'other' ? other : owner, sid: 'sess_fixture',
        exp: Math.floor(Date.now() / 1000) + 60, iss: issuer,
        ...(token === 'restricted' ? { sts: 'pending' } : {}),
      };
    },
  });
  const isMember = vi.fn(async (_id: string) => true);
  const resolve = vi.fn(async (target: typeof first) => ({
    handle: target.handle, clerkUserId: target.owner, containerId: target.containerId,
  }));
  const app = createDevstackPreviewRoutes({
    config, clerkAuth, isMember, resolve, publishableKey: 'pk_test_preview_fixture',
  });
  const request = (path: string, cookie?: string, host = new URL(origin).host) =>
    app.request(`${origin}${path}`, {
      headers: { host, ...(cookie ? { cookie: `__session=${cookie}` } : {}) },
    });
  return { request, resolve, isMember };
}

describe('Stage 3 registered worktree launcher', () => {
  it('prompts for normal Clerk login and keeps the selected return path', async () => {
    const { request, resolve } = fixture();
    const response = await request('/devstack/first/feature-one');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain('pk_test_preview_fixture');
    expect(page).toContain('var redirectTarget = "/devstack/first/feature-one"');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('shows only the signed-in operator’s registered worktrees', async () => {
    const { request, resolve } = fixture();
    const response = await request('/devstack', 'owner');
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('/devstack/first/feature-one');
    expect(page).toContain('/devstack/second/feature-two');
    expect(page).not.toContain('feature-other');
    expect(page).not.toContain(first.containerId);
    expect(resolve.mock.calls.map(([target]) => target.worktree)).toEqual(['feature-one', 'feature-two']);
  });

  it('opens the only choice or an explicit matching worktree at the canonical owner route', async () => {
    const { request } = fixture([first, hidden]);
    for (const path of ['/devstack', '/devstack/first/feature-one']) {
      const response = await request(path, 'owner');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/vm/dev-one/');
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect((await request('/devstack/other/feature-other', 'owner')).status).toBe(404);
  });

  it('checks current membership and refuses a replaced runtime', async () => {
    const { request, resolve, isMember } = fixture();
    expect((await request('/devstack', 'restricted')).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    isMember.mockResolvedValueOnce(false);
    expect((await request('/devstack', 'owner')).status).toBe(403);
    resolve.mockResolvedValueOnce({ handle: first.handle, clerkUserId: owner, containerId: 'f'.repeat(64) });
    expect((await request('/devstack/first/feature-one', 'owner')).status).toBe(404);
  });

  it('rejects a different host and ignores caller-selected return targets', async () => {
    const { request, resolve } = fixture();
    expect((await request('/devstack', 'owner', 'other.example.test')).status).toBe(404);
    expect((await request('/devstack/first/feature-one?redirect_url=https://other.example.test')).status).toBe(400);
    expect((await request('/devstack/first/%2Fetc')).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('routes a verified browser through the registered Platform app to its owner preview', async () => {
    const instance = 'stage-three';
    const config = loadDevstackPreviewConfig(JSON.stringify({ ...previewConfig, targets: [first] }), instance)!;
    const { db } = await createTestPlatformDb();
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', new URL(origin).host);
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    const clerkAuth = createClerkAuth({
      async verifyToken(token) {
        return {
          sub: token === 'owner' ? owner : other,
          iss: issuer, sid: 'sess_fixture', exp: Math.floor(Date.now() / 1000) + 60,
        };
      },
    });
    const orchestrator = stubOrchestrator();
    const launcher = createDevstackPreviewRoutes({
      config, clerkAuth, publishableKey: 'pk_test_preview_fixture',
      isMember: async () => true,
      resolve: target => resolveRegisteredRuntimeEndpoint(
        db, instance, { source: 'auth', userId: target.owner, handle: target.handle }, target.handle, 'primary',
      ),
    });
    const app = createApp({
      db, orchestrator, clerkAuth, registeredRuntimeInstance: instance, devstackPreviewRoutes: launcher,
      env: { PLATFORM_RUNTIME_MODE: 'local', MATRIX_APP_ORIGIN: origin, MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true' },
    });
    try {
      await bootstrapDevstackIdentity(db, {
        instance, clerkUserId: owner, handle: first.handle, email: 'owner@example.test', displayName: 'Owner',
        containerId: first.containerId, gatewayPort: 4000, shellPort: 3000,
      });
      const upstream = vi.fn(async () => new Response('registered DevStack Shell'));
      vi.stubGlobal('fetch', upstream);
      const request = (path: string, cookie?: string) => app.request(`${origin}${path}`, {
        headers: { host: new URL(origin).host, ...(cookie ? { cookie: `__session=${cookie}` } : {}) },
      });
      expect(await (await request('/devstack')).text()).toContain('Sign in to DevStack Preview');
      const selected = await request('/devstack', 'owner');
      expect(selected.status).toBe(302);
      expect(selected.headers.get('location')).toBe('/vm/dev-one/');
      expect((await request('/vm/dev-one/', 'other')).status).toBe(404);
      expect(await (await request('/vm/dev-one/', 'owner')).text()).toBe('registered DevStack Shell');
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(orchestrator.provision).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await app.shutdownPostHog();
      await destroyTestPlatformDb(db);
    }
  });

  it('rejects preview configuration for unregistered mode or ambiguous workspace routes', () => {
    const serialized = JSON.stringify(previewConfig);
    expect(loadDevstackPreviewConfig(undefined, undefined)).toBeUndefined();
    expect(() => loadDevstackPreviewConfig(serialized, undefined)).toThrow(/DevStack preview/);
    const duplicateRoute = { ...first, runtime: 'alternative', worktree: 'alternative-worktree' };
    expect(() => loadDevstackPreviewConfig(
      JSON.stringify({ ...previewConfig, targets: [first, duplicateRoute] }), 'stage-three',
    )).toThrow(/DevStack preview/);
  });
});
