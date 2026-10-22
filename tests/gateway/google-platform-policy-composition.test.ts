import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestIntegrationDb } from '../integrations/native-integration-db-test-helper.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { profileInput } from './google-data/fixtures.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
let db: PlatformDb | undefined;
afterEach(async () => { await db?.destroy(); db = undefined; });
describe('machine policy composition', () => {
  it('requires the verified signed machine context and canonical active Gmail account', async () => {
    ({ db } = await createTestIntegrationDb());
    const owner = await db.createUser({ clerkId: 'owner-one', handle: 'owner-one', displayName: 'Owner', email: 'owner@example.test', containerId: 'owner-container' });
    const connection = await db.connectService({ userId: owner.id, service: 'gmail', pipedreamAccountId: 'apn_synthetic', accountLabel: 'Email', scopes: [] });
    await db.googleData!.purgeDelivery.pinRuntime('owner-one', 'machine-one');
    const generation = '523e4567-e89b-42d3-a456-426614174000';
    const profile = profileInput({ credentialKind: 'byo', credentialGeneration: generation,
      endpoint: 'https://api.example.invalid/v1/messages', harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'], harnessRevision: 'reviewed-build-1' });
    profile.binding.recipientChain[0]!.endpoint = profile.binding.endpoint;
    await db.googleData!.repository.reviewProfile(profile, 0);
    const routes = createIntegrationRoutes({ db, pipedream: { getAppInfo: vi.fn(async () => undefined) } as never, webhookSecret: 'synthetic', resolveUserId: async () => owner.id });
    const body = JSON.stringify({ binding: { runId: 'run_policy', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', accessSourceId: 'owner_anthropic_key' },
      googleAccountId: connection.id, purposeId: 'mail-assistance', dataKinds: ['gmail-content'],
      identity: { endpoint: profile.binding.endpoint, api: 'anthropic-messages', modelId: 'model-a', harnessVersion: 'reviewed-build-1', credential: { kind: 'api_key', generation, fingerprint: profile.binding.credentialFingerprint } } });
    const request = (app: Hono) => app.request('/gmail/processing/authorize', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-platform-user-id': 'owner-one', 'x-platform-verified': 'forged', 'x-matrix-machine-id': 'fake' }, body });
    expect((await request(routes)).status).toBe(401);
    const wrapped = (signed: boolean, clerkId = 'owner-one', machineId = 'machine-one', personalOwner = clerkId) => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        // This models the already authenticated platform mount's private context;
        // browser headers above cannot set these values.
        c.set('internalSignedOwnerDelegation', signed);
        c.set('internalContainerHandle', 'machine-one');
        c.set('internalContainerMachineId', machineId);
        c.set('internalContainerPersonalOwner', personalOwner);
        c.set('internalContainerClerkUserId', clerkId);
        await next();
      });
      app.route('/', routes); return app;
    };
    expect((await request(wrapped(false))).status).toBe(401);
    expect((await request(wrapped(true, 'owner-two'))).status).toBe(401);
    expect((await request(wrapped(true, 'owner-one', 'machine-one', 'other-owner'))).status).toBe(401);
    expect((await request(wrapped(true, 'owner-one', 'other-machine'))).status).toBe(403);
    const missing = await request(wrapped(true));
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ error: 'consent_required', consentRevision: 0 });
    await db.updateServiceStatus(connection.id, 'revoked');
    expect((await request(wrapped(true))).status).toBe(403);
  });
});
