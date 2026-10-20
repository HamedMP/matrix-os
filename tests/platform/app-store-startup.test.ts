import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { ensurePlatformUser, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createConfiguredAppStoreRuntime } from '../../packages/platform/src/app-store/startup.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
let db: PlatformDB;
let app: ReturnType<typeof createApp>;
afterEach(async () => { await app?.shutdownPostHog(); await destroyTestPlatformDb(db); });
describe('platform App Store production mount', () => {
  it('mounts machine-authenticated status before admin middleware and removes the public identity-spoofing API', async () => {
    ({ db } = await createTestPlatformDb()); const secret = 'platform-secret-for-store-composition';
    await ensurePlatformUser(db, { clerkId: 'user_author', handle: 'author', displayName: 'Author', email: 'author@example.test', containerId: 'clerk:user_author' });
    await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: 'user_author', handle: 'author', provisioningClass: 'customer', runtimeSlot: 'primary', status: 'running', provisionedAt: new Date().toISOString() });
    const runtime = createConfiguredAppStoreRuntime({ db, env: { MATRIX_APP_STORE_ENABLED: '1' }, platformSecret: secret });
    app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: secret, appStoreRoutes: runtime.routes, env: {} });
    const response = await app.request('/internal/containers/author/app-store/status', { headers: { authorization: `Bearer ${buildPlatformVerificationToken('author', secret)}` } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ enabled: true, reviewer: false });
    const legacy = await app.request('/api/store/apps', { headers: { authorization: `Bearer ${secret}` } }); expect(legacy.status).toBe(404);
    await runtime.shutdown();
  });
});
