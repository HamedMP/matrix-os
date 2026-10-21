import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestIntegrationDb } from '../integrations/native-integration-db-test-helper.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { profileInput } from './google-data/fixtures.js';
import { signGoogleProcessingEnvelope, verifyGoogleProcessingEnvelope } from '../../packages/gateway/src/google-data/runtime/envelope.js';

let db: PlatformDb | undefined;
afterEach(async () => { await db?.destroy(); db = undefined; });
describe('platform-owned Google policy composition', () => {
  it('migrates the registry, mounts owner consent routes and preserves exact Gmail ownership', async () => {
    ({ db } = await createTestIntegrationDb());
    expect(db.googleData).toBeDefined();
    expect(db.googleData!.requestLedger).toBeDefined();
    const machineToken = 'synthetic-machine-token';
    const signedRequest = { method: 'POST', path: '/read-call', body: '{}', machineToken };
    const claim = { ownerId: 'owner-one', runId: 'run_policy', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
      profileId: '123e4567-e89b-42d3-a456-426614174001', profileRevision: 1,
      consentId: '123e4567-e89b-42d3-a456-426614174002', consentRevision: 1,
      googleAccountId: '123e4567-e89b-42d3-a456-426614174000', purposeId: 'mail-assistance',
      routeDigest: 'a'.repeat(64), policyExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const envelope = verifyGoogleProcessingEnvelope(signGoogleProcessingEnvelope(claim, signedRequest), { ...signedRequest, ownerId: claim.ownerId });
    await db.googleData!.requestLedger.consume(envelope);
    await expect(db.googleData!.requestLedger.consume(envelope)).rejects.toMatchObject({ code: 'replay' });
    const owner = await db.createUser({ clerkId: 'owner-one', handle: 'owner-one', displayName: 'Owner', email: 'owner@example.test', containerId: 'owner-container' });
    const foreign = await db.createUser({ clerkId: 'owner-two', handle: 'owner-two', displayName: 'Other', email: 'other@example.test', containerId: 'other-container' });
    const native = await db.connectService({ userId: owner.id, service: 'gmail', pipedreamAccountId: 'gmail_123e4567-e89b-42d3-a456-426614174000', accountLabel: 'Direct', scopes: [] });
    const pipedream = await db.connectService({ userId: owner.id, service: 'gmail', pipedreamAccountId: 'apn_synthetic', accountLabel: 'Pipedream', scopes: [] });
    const other = await db.connectService({ userId: foreign.id, service: 'gmail', pipedreamAccountId: 'apn_other', accountLabel: 'Other', scopes: [] });
    const reviewed = await db.googleData!.repository.reviewProfile(profileInput(), 0);
    const app = createIntegrationRoutes({ db, pipedream: { getAppInfo: vi.fn(async () => undefined) } as never, webhookSecret: 'synthetic', resolveUserId: async () => owner.id });
    for (const connection of [native, pipedream]) {
      const response = await app.request(`/gmail/processing-profiles?connectionId=${connection.id}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(reviewed.id);
    }
    expect((await app.request(`/gmail/processing-profiles?connectionId=${other.id}`)).status).toBe(404);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const response = await app.request('/gmail/processing-consents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      connectionId: native.id, profileId: reviewed.id, purposeId: 'mail-assistance', profileRevision: 1, evidenceRevision: 1,
      disclosureRevision: 1, retentionRevision: 1, dataKinds: ['gmail-metadata', 'gmail-content'], expiresAt, expectedConsentRevision: 0, accepted: true,
    }) });
    expect(response.status).toBe(200);
    expect((await db.googleData!.repository.snapshot({ ownerId: 'owner-one', googleAccountId: native.id, purposeId: 'mail-assistance', profileId: reviewed.id })).consent?.status).toBe('active');
    expect((await app.request(`/gmail/processing-consents/${native.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await db.googleData!.repository.snapshot({ ownerId: 'owner-one', googleAccountId: native.id, purposeId: 'mail-assistance', profileId: reviewed.id })).consent?.status).toBe('revoked');
  });
});
