import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { deleteContainer, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { isPlatformRuntimeShellPath, shouldServePlatformRuntimeShell } from '../../packages/platform/src/session-routing-middleware.js';
import { setupProxyRoutingTest, cleanupProxyRoutingTest, stubOrchestrator } from './proxy-routing-test-utils.js';

let db: PlatformDB;
beforeEach(async () => { db = await setupProxyRoutingTest(); });
afterEach(async () => { await cleanupProxyRoutingTest(db); });

describe('platform-owned Slack setup', () => {
  it.each(['/slack/install', '/slack/oauth/complete'])('keeps %s independent of a customer computer', (path) => {
    expect(isPlatformRuntimeShellPath(path)).toBe(true);
    expect(shouldServePlatformRuntimeShell({ path, isAppDomain: true, userId: 'user_alice', identitySource: 'auth' })).toBe(true);
    expect(shouldServePlatformRuntimeShell({ path, isAppDomain: false, userId: 'user_alice', identitySource: 'auth' })).toBe(false);
    expect(shouldServePlatformRuntimeShell({ path, isAppDomain: true, userId: 'user_alice', identitySource: 'mobile-session' })).toBe(false);
    expect(isPlatformRuntimeShellPath(path + '/other')).toBe(false);
  });

  it.each([
    ['/slack/install', 'running'], ['/slack/install', 'provisioning'],
    ['/slack/oauth/complete', 'running'], ['/slack/oauth/complete', 'provisioning'],
  ] as const)('serves %s while the customer computer is %s', async (path, status) => {
    await deleteContainer(db, 'alice');
    await insertUserMachine(db, { machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff128', clerkUserId: 'user_alice',
      handle: 'alice', runtimeSlot: 'primary', status, hetznerServerId: 123472, publicIPv4: '203.0.113.25',
      imageVersion: 'older-customer-shell', serverType: 'cpx22', provisionedAt: '2026-04-26T12:00:00.000Z' });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(String(url) === `http://127.0.0.1:3200${path}` ? 'platform-slack-setup' : 'old-computer-404', { status: String(url).startsWith('http://127.0.0.1:3200/') ? 200 : 404 }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }) });
    const response = await app.request(path, { headers: { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('platform-slack-setup');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3200${path}`);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
