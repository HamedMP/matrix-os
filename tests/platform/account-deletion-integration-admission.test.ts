import { Hono } from 'hono';
import { createGoogleOwnerConsentClient, googleOwnerConsentDigest, type GoogleOwnerConsentInput } from '../../packages/gateway/src/google-data/runtime/owner-consent-client.js';
import { createPlatformIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { authenticatedApprovalProxyProof } from '../../packages/platform/src/canonical-owner-approval-proxy.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountDeletionMutationGuard } from '../../packages/platform/src/account-deletion/integration-admission.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { insertContainer } from '../../packages/platform/src/db.js';
import { createGmailOwnerSessionVerifier, registerInternalIntegrationRoutes } from '../../packages/platform/src/internal-integration-route-registration.js';
import { registerCustomMcpRoutes } from '../../packages/platform/src/custom-mcp-route-registration.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
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
  it('requires independent owner authorization for Gmail consent mutations on machine routes', async () => {
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
    await insertContainer(db, { handle: 'consenttest', clerkUserId: owner, port: 5002, shellPort: 6002, status: 'running' });
    const platformSecret = 'platform-test-secret';
    const headers = { authorization: `Bearer ${buildPlatformVerificationToken('consenttest', platformSecret)}`,
      'content-type': 'application/json' };
    const routes = new Hono();
    routes.get('/gmail/processing-profiles', c => c.json({ profiles: [] }));
    routes.post('/gmail/processing-consents', c => { mutation(); return c.json({ consentRevision: 1, consentActive: true }); });
    routes.delete('/gmail/processing-consents/:account', c => { mutation(); return c.json({ revoked: true }); });
    const mounted = new Hono();
    const jwtSecret = 'consent-session-test-key-with-at-least-32-characters';
    registerInternalIntegrationRoutes(mounted, { db, platformSecret, internalIntegrationRoutes: routes,
      verifyGmailOwnerSession: createGmailOwnerSessionVerifier(undefined, jwtSecret) });

    const base = '/internal/containers/consenttest/integrations/gmail';
    expect((await mounted.request(`${base}/processing-profiles`, { headers })).status).toBe(200);
    expect((await mounted.request(`${base}/processing-consents`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect((await mounted.request(`${base}/processing-consents/account`, { method: 'DELETE', headers })).status).toBe(403);
    expect(mutation).not.toHaveBeenCalled();
    const consent: GoogleOwnerConsentInput = { connectionId: '123e4567-e89b-42d3-a456-426614174000',
      accepted: true, expectedConsentRevision: 0, profileId: '223e4567-e89b-42d3-a456-426614174000',
      profileRevision: 1, evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1,
      purposeId: 'assistant', dataKinds: ['gmail-metadata'], expiresAt: new Date(Date.now() + 60000).toISOString() };
    const actionDigest = googleOwnerConsentDigest(consent);
    const approvals = '/api/chats/chat_one/runs/run_one/approvals/decision_one';
    const approvalProof = async (sessionProvenance?: 'clerk-browser') => {
      const proof = await authenticatedApprovalProxyProof({
        method: 'POST', path: approvals, handle: 'consenttest', platformSecret,
        identity: { handle: 'consenttest', userId: owner, source: 'auth', sessionProvenance },
        request: new Request(`https://example.invalid${approvals}`, { method: 'POST',
          body: JSON.stringify({ decision: 'approve', clientRequestId: 'req_one', actionDigest }) }),
      });
      if (typeof proof !== 'string') throw Error('Missing signed approval fixture');
      return proof;
    };
    const client = createGoogleOwnerConsentClient(createPlatformIntegrationTransport({
      baseUrl: 'http://localhost/internal/containers/consenttest/integrations',
      machineToken: buildPlatformVerificationToken('consenttest', platformSecret),
      fetchImpl: (url, init) => Promise.resolve(mounted.request(url.toString(), init)),
    }));
    await expect(client.recordConsent(owner, consent, undefined, await approvalProof())).rejects.toThrow();
    const proof = await approvalProof('clerk-browser');
    await expect(client.recordConsent(owner, { ...consent, expectedConsentRevision: 1 }, undefined, proof)).rejects.toThrow();
    await expect(client.recordConsent(owner, consent, undefined, proof)).resolves.toMatchObject({ consentActive: true });
    const ownerJwt = { secret: jwtSecret, clerkUserId: owner, handle: 'consenttest', gatewayUrl: 'https://example.invalid' };
    const remove = (token: string) => mounted.request(`${base}/processing-consents/account`, { method: 'DELETE',
      headers: { ...headers, 'x-matrix-google-owner-authorization': `Bearer ${token}` } });
    expect((await remove((await issueSyncJwt(ownerJwt)).token)).status).toBe(403);
    expect((await remove((await issueSyncJwt({ ...ownerJwt, sessionProvenance: 'clerk-device', expiresInSec: -1 })).token)).status).toBe(403);
    expect((await remove((await issueSyncJwt({ ...ownerJwt, sessionProvenance: 'clerk-device' })).token)).status).toBe(200);
    expect(mutation).toHaveBeenCalledTimes(2);
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
