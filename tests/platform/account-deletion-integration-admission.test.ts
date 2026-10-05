import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountDeletionMutationGuard } from '../../packages/platform/src/account-deletion/integration-admission.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { insertContainer } from '../../packages/platform/src/db.js';
import { registerInternalIntegrationRoutes } from '../../packages/platform/src/internal-integration-route-registration.js';
import { registerCustomMcpRoutes } from '../../packages/platform/src/custom-mcp-route-registration.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
const owner = 'user_integrationguard123';
const secret = 'integration-admission-secret-at-least-32';
const env = { ACCOUNT_DELETION_SECRET: secret };
describe('account deletion integration admission', () => {
  let db: PlatformDB;
  let app: Hono;
  const mutation = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks(); ({ db } = await createTestPlatformDb());
    app = new Hono();
    app.use('*', createAccountDeletionMutationGuard({ db, env, resolveOwner: () => owner }));
    app.get('/connection', c => c.json({ existing: true }));
    app.post('/connect', async c => { mutation(); return c.json({ connected: true }); });
    app.get('/oauth/callback', async c => { mutation(); return c.json({ connected: true }); });
    await new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: owner, appleTokens: [] }, false);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
  it('allows connection reads during grace while refusing new grants and OAuth token exchanges', async () => {
    expect((await app.request('/connection')).status).toBe(200);
    expect((await app.request('/connect', { method: 'POST' })).status).toBe(409);
    expect((await app.request('/oauth/callback')).status).toBe(409);
    expect(mutation).not.toHaveBeenCalled();
  });
  it('fails closed for reads after destruction starts and permits creation again after cancellation', async () => {
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'processing' }).execute();
    expect((await app.request('/connection')).status).toBe(409);
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
    expect((await app.request('/connect', { method: 'POST' })).status).toBe(200);
    expect(mutation).toHaveBeenCalledOnce();
  });
  it('requires a verified owner from the surface adapter', async () => {
    const missing = new Hono(); missing.use('*', createAccountDeletionMutationGuard({ db, env, resolveOwner: () => null }));
    missing.post('/connect', c => c.json({ connected: true }));
    expect((await missing.request('/connect', { method: 'POST' })).status).toBe(401);
  });
  it('wires signed internal integration and MCP mutations to the verified machine owner', async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    await insertContainer(db, { handle: 'deletiontest', clerkUserId: owner, port: 5001, shellPort: 6001, status: 'running' });
    const platformSecret = 'platform-test-secret';
    const headers = { authorization: `Bearer ${buildPlatformVerificationToken('deletiontest', platformSecret)}` };
    const backend = () => {
      const routes = new Hono(); routes.get('/probe', c => c.json({ connected: true }));
      routes.post('/connect', c => { mutation(); return c.json({ connected: true }); }); return routes;
    };
    const mounted = new Hono();
    registerInternalIntegrationRoutes(mounted, { db, platformSecret, internalIntegrationRoutes: backend() });
    registerCustomMcpRoutes(mounted, { db, platformSecret, internalCustomMcpRoutes: backend() });
    for (const namespace of ['integrations', 'mcp-servers']) {
      const path = `/internal/containers/deletiontest/${namespace}`;
      expect((await mounted.request(`${path}/probe`, { headers })).status).toBe(200);
      expect((await mounted.request(`${path}/connect`, { method: 'POST', headers })).status).toBe(409);
    }
    expect(mutation).not.toHaveBeenCalled();
  });
});
