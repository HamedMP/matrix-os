import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { GoogleDataModelSchema } from '../../packages/gateway/src/google-data/profiles.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, consentInput, now, profileInput } from './google-data/fixtures.js';
import { qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';
import { createGooglePlatformPolicyRoutes } from '../../packages/gateway/src/google-data/runtime/platform-routes.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { googleManagedInferenceIdentity } from '../../packages/gateway/src/google-data/managed/identity.js';
import type { ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
const binding = (): ManagedPiRuntimeBinding => ({ kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one',
  workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64), accessSourceId: 'matrix_included', requestClass: 'interactive', capabilities: ['artifact.read'],
  route: { api: 'openai-completions', modelId: qualifiedRouteFixture().canonicalModelId, input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 } });
const request = () => ({ binding: { runId: binding().runId, runtimeHandle: binding().runtimeHandle, executionGeneration: '1', accessSourceId: 'matrix_included', requestClass: 'interactive' },
  googleAccountId: accountId, purposeId: 'mail-assistance', dataKinds: ['gmail-content'], identity: googleManagedInferenceIdentity(binding(), qualifiedRouteFixture()) });
async function reviewed() {
  const descriptor = qualifiedRouteFixture().descriptor; const observed = request().identity;
  const value = profileInput({ providerId: 'cloudflare', providerAccountId: descriptor.cloudflare.accountId, credentialKind: 'managed', credentialGeneration: descriptor.credential.generation,
    credentialFingerprint: descriptor.credential.fingerprint, endpoint: descriptor.upstream.endpoint, recipientChain: descriptor.recipientChain,
    harnessId: GOOGLE_POLICY_HARNESS_ID['openai-completions'], harnessRevision: observed.harnessVersion });
  value.allowedModels = [descriptor.upstream.canonicalModelId]; value.evidence.referenceDigest = descriptor.evidence.referenceDigest; value.evidence.expiresAt = descriptor.evidence.expiresAt;
  value.disclosure.recipients = [{ recipientId: 'cloudflare', name: 'Cloudflare', role: 'inference processor' }]; return db.repository.reviewProfile(value, 0);
}
function setup(resolveManagedRoute: ((...args: any[]) => Promise<any>) | null = vi.fn(async () => qualifiedRouteFixture())) {
  const app = createGooglePlatformPolicyRoutes({ repository: db.repository, resolveRuntime: async () => ({ ownerId: 'owner-one', machineId: 'machine-one' }),
    ownsGmailAccount: async () => true, now: () => now, ...(resolveManagedRoute ? { resolveManagedRoute } : {}) });
  const post = (action: string, body: unknown) => app.request(`/gmail/processing/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, resolveManagedRoute };
}
beforeEach(async () => { ({ db } = await createAuthorityFixture()); }); afterEach(async () => { vi.restoreAllMocks(); await db.destroy(); });
describe('managed processing identity with current trusted control proof', () => {
  it('uses stable upstream fingerprint/generation and exact relay endpoint without a temporary lease token', () => {
    for (const model of MANAGED_WORKERS_AI_MODEL_IDS) expect(GoogleDataModelSchema.safeParse(model).success).toBe(true);
    expect(GoogleDataModelSchema.safeParse('@cf/unreviewed/model').success).toBe(false);
    const identity = request().identity; expect(identity.endpoint).toBe(qualifiedRouteFixture().descriptor.relay.endpoint);
    expect(identity.credential).toEqual({ kind: 'auth_token', ...qualifiedRouteFixture().descriptor.credential });
    expect(JSON.stringify(identity)).not.toContain('sk-matrix'); expect(identity.managed?.requestClass).toBe('interactive');
  });
  it('requires an existing reviewed profile and affirmative consent even with genuine managed proof', async () => {
    const f = setup(); expect((await f.post('authorize', request())).status).toBe(503);
    const profile = await reviewed(); const required = await f.post('authorize', request()); expect(required.status).toBe(428);
    expect(JSON.stringify(await required.json())).not.toMatch(/fingerprint|generation|accountSettingsReferenceDigest/);
    await db.repository.recordConsent(consentInput(profile.id, { expiresAt: '2026-10-22T12:00:00.000Z' }), 0);
    const response = await f.post('authorize', request()); expect(response.status).toBe(200); const result = await response.json();
    expect(result.resolvedRoute.endpoint).toBe(qualifiedRouteFixture().descriptor.upstream.endpoint);
    expect((await f.post('revalidate', { ...request(), stamp: result.stamp })).status).toBe(200);
  });
  it.each(['missing', 'changed', 'class', 'key', 'endpoint', 'recipient', 'evidence'])('denies %s proof rather than treating supplied facts as approval', async change => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id, { expiresAt: '2026-10-22T12:00:00.000Z' }), 0);
    const value: any = request(); const control = vi.fn(async () => qualifiedRouteFixture());
    if (change === 'changed') { const changed = qualifiedRouteFixture(); changed.digest = 'd'.repeat(64); control.mockResolvedValue(changed); }
    if (change === 'class') value.binding.requestClass = 'background';
    if (change === 'key') value.identity.credential.fingerprint = 'd'.repeat(64);
    if (change === 'endpoint') value.identity.endpoint = 'https://forged.example.test/v1/chat/completions';
    if (change === 'recipient') value.identity.managed.descriptor.recipientChain[0].accountId = 'forged';
    if (change === 'evidence') value.identity.managed.descriptor.evidence.referenceDigest = 'd'.repeat(64);
    const f = setup(change === 'missing' ? null : control);
    const response = await f.post('authorize', value); expect(response.status).not.toBe(200); expect(response.status).not.toBe(428);
  });
  it('checks fresh control again after policy reads and refuses rotation before releasing a stamp', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id, { expiresAt: '2026-10-22T12:00:00.000Z' }), 0);
    const resolver = vi.fn().mockResolvedValueOnce(qualifiedRouteFixture()).mockRejectedValue(new Error('private control failure'));
    const response = await setup(resolver).post('authorize', request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
  });
});
