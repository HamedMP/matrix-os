import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator, JWT_SECRET } from './proxy-routing-test-utils.js';
import { registerAppRuntimeRoutes } from '../../packages/gateway/src/server/app-runtime-routes.js';
import { authMiddleware } from '../../packages/gateway/src/auth.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

const platformSecret = 'fictional-pilot-platform-secret';
const env = { MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: 'user_pilotA' };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('pilot Native Mobile WebView app capability', () => {
  it('preserves actual gateway one-use/per-slug verification without a shell or forged platform actor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pilot-webview-'));
    const { db } = await createTestPlatformDb();
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    vi.stubEnv('PLATFORM_SECRET', platformSecret);
    vi.stubEnv('MATRIX_HANDLE', 'pilot');
    vi.stubEnv('MATRIX_USER_ID', 'user_pilotA');
    vi.stubEnv('MATRIX_CLERK_USER_ID', 'user_pilotA');
    const gatewayToken = buildPlatformVerificationToken('pilot', platformSecret);
    vi.stubEnv('MATRIX_AUTH_TOKEN', gatewayToken);
    await mkdir(join(home, 'apps', 'notes', 'assets'), { recursive: true });
    await writeFile(join(home, 'apps', 'notes', 'matrix.json'), JSON.stringify({ name: 'Notes', slug: 'notes', runtime: 'static', version: '1.0.0', runtimeVersion: '1.0.0', scope: 'personal', listingTrust: 'first_party' }));
    await writeFile(join(home, 'apps', 'notes', 'index.html'), '<html><body>Pilot notes</body></html>');
    await writeFile(join(home, 'apps', 'notes', 'assets', 'private.txt'), 'app-scoped asset');
    const gateway = new Hono();
    gateway.use('*', authMiddleware(gatewayToken));
    const manager = registerAppRuntimeRoutes(gateway, { homePath: home, appSessionMasterSecret: 'fictional-app-secret-with-entropy', devAppAuthBypass: false, publicHost: 'app.matrix-os.com', onAppError: vi.fn() });
    const calls: Array<{ path: string; headers: Headers }> = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe('https://203.0.113.20');
      // Production host nginx /apps/ goes straight to gateway:4000, not Next.
      calls.push({ path: target.pathname, headers: new Headers(init?.headers) });
      return gateway.request(`https://gateway.invalid${target.pathname}${target.search}`, init);
    });
    try {
      await insertUserMachine(db, { machineId: 'fictional-app-machine', handle: 'pilot', clerkUserId: 'user_pilotA', runtimeSlot: 'primary', status: 'running', publicIPv4: '203.0.113.20', provisionedAt: '2026-10-23T00:00:00.000Z' });
      const platform = createApp({ db, orchestrator: stubOrchestrator(), platformSecret, env,
        clerkAuth: createClerkAuth({ verifyToken: async token => { if (token !== 'verified-clerk-fixture') throw new Error('Invalid fixture'); return { sub: 'user_pilotA' }; } }) });
      const mint = await platform.request('/vm/pilot/api/apps/notes/session-token', { method: 'POST', headers: { host: 'app.matrix-os.com', authorization: 'Bearer verified-clerk-fixture', 'content-type': 'application/json' }, body: '{}' });
      expect(mint.status).toBe(200);
      const { launchUrl } = await mint.json();
      expect(launchUrl).toMatch(/^\/apps\/notes\/\?session=pilot\./);
      const launch = () => platform.request(launchUrl, { headers: { host: 'app.matrix-os.com', 'x-platform-user-id': 'user_forged', 'x-platform-verified': 'forged' } });
      const response = await launch();
      expect(response.status).toBe(302);
      expect(calls.at(-1)?.headers.get('authorization')).toBeNull();
      expect(calls.at(-1)?.headers.get('x-platform-user-id')).toBeNull();
      expect(calls.at(-1)?.headers.get('x-platform-verified')).toBeNull();
      const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const page = await platform.request('/apps/notes/', { headers: { host: 'app.matrix-os.com', cookie: cookies } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Pilot notes');
      expect((await launch()).status).toBe(401); // One-use replay rejected by actual gateway.
      const asset = await platform.request('/apps/notes/assets/private.txt', { headers: { host: 'app.matrix-os.com', cookie: cookies } });
      expect(asset.status).toBe(200);
      const invalidCookie = cookies.replace(/matrix_app_session__notes=[^;]+/, 'matrix_app_session__notes=forged.cookie');
      expect((await platform.request('/apps/notes/assets/private.txt', { headers: { host: 'app.matrix-os.com', cookie: invalidCookie } })).status).toBe(401);
      // An unsigned route cookie alone cannot unlock the platform bearer asset shortcut.
      const before = calls.length;
      expect((await platform.request('/apps/notes/assets/private.txt', { headers: { host: 'app.matrix-os.com', cookie: 'matrix_app_route=pilot' } })).status).toBe(403);
      expect(calls).toHaveLength(before);
      await db.executor.updateTable('user_machines').set({ clerk_user_id: 'user_outside' }).where('handle', '=', 'pilot').execute();
      expect((await platform.request('/apps/notes/', { headers: { host: 'app.matrix-os.com', cookie: cookies } })).status).toBe(403);
      expect(calls).toHaveLength(before);
    } finally {
      network.mockRestore(); await manager.shutdownAll(); await destroyTestPlatformDb(db); await rm(home, { recursive: true, force: true });
    }
  });
});
