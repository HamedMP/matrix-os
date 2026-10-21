import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGooglePlatformPolicyRoutes } from '../../packages/gateway/src/google-data/runtime/platform-routes.js';
import { createGooglePlatformPolicyClient } from '../../packages/gateway/src/google-data/runtime/platform-client.js';
import { resolveGooglePolicyProfile, GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, consentInput, now, profileInput } from './google-data/fixtures.js';
import type { GoogleInferenceIdentity } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
const generation = '523e4567-e89b-42d3-a456-426614174000';
const identity = (overrides: Partial<GoogleInferenceIdentity> = {}): GoogleInferenceIdentity => ({ endpoint: 'https://api.example.invalid/v1/messages?beta=true', api: 'anthropic-messages', modelId: 'model-a', harnessVersion: 'reviewed-build-1', credential: { kind: 'api_key', fingerprint: 'a'.repeat(64), generation }, ...overrides });
const binding = () => ({ runId: 'run_policy', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', accessSourceId: 'owner_anthropic_key' });
const input = () => ({ binding: binding(), googleAccountId: accountId, purposeId: 'mail-assistance', dataKinds: ['gmail-content'], identity: identity() });
async function reviewed(purposeId = 'mail-assistance') {
  const value = profileInput({ endpoint: identity().endpoint, credentialKind: 'byo', credentialGeneration: generation, harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'], harnessRevision: identity().harnessVersion });
  value.binding.recipientChain[0]!.endpoint = identity().endpoint; value.purposeId = purposeId;
  return db.repository.reviewProfile(value, 0);
}
function setup(overrides: Record<string, unknown> = {}) {
  const resolveRuntime = vi.fn(async () => ({ ownerId: 'owner-one', machineId: 'machine-one' }));
  const ownsGmailAccount = vi.fn(async (owner: string, account: string) => owner === 'owner-one' && account === accountId);
  const app = createGooglePlatformPolicyRoutes({ repository: db.repository, resolveRuntime, ownsGmailAccount, now: () => now, ...overrides });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/gmail/processing/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, post, resolveRuntime, ownsGmailAccount };
}
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { vi.restoreAllMocks(); await db.destroy(); });
describe('central Google processing policy', () => {
  it('returns safe consent-required disclosure then an exact durable authorization', async () => {
    const profile = await reviewed(); const { post } = setup();
    const missing = await post('authorize', input()); expect(missing.status).toBe(428);
    const notice = await missing.json(); expect(notice).toMatchObject({ error: 'consent_required', consentRevision: 0, disclosure: { profileId: profile.id, googleAccountId: accountId } });
    expect(JSON.stringify(notice)).not.toMatch(/fingerprint|credential|verified-account-map|api\.example/);
    await db.repository.recordConsent(consentInput(profile.id), 0);
    const response = await post('authorize', input()); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.resolvedRoute.endpoint).toBe(identity().endpoint);
    expect(result.stamp).toMatchObject({ ownerId: 'owner-one', profileId: profile.id });
    const check = await post('revalidate', { ...input(), stamp: result.stamp }); expect(check.status).toBe(200);
  });
  it('selects within the requested purpose while retaining same-purpose ambiguity denial', async () => {
    const profile = await reviewed(); await reviewed('email-archiving');
    await db.repository.recordConsent(consentInput(profile.id), 0); const { post } = setup();
    expect((await post('authorize', input())).status).toBe(200);
    expect((await post('authorize', { ...input(), purposeId: 'email-archiving' })).status).toBe(428);
    expect((await post('authorize', { ...input(), purposeId: 'unknown' })).status).toBe(503);
    await reviewed(); expect((await post('authorize', input())).status).toBe(503);
  });
  it('never accepts caller owner/approval/profile fields or forged owner headers as authority', async () => {
    const { post } = setup();
    for (const extra of [{ ownerId: 'other' }, { profileId: generation }, { approved: true }, { binding: { ...binding(), ownerId: 'other' } }]) expect((await post('authorize', { ...input(), ...extra })).status).toBe(400);
    const denied = setup({ resolveRuntime: async () => null });
    expect((await denied.post('authorize', input(), { 'x-matrix-owner-id': 'owner-one', authorization: 'Bearer forged' })).status).toBe(401);
    expect((await setup({ ownsGmailAccount: async () => false }).post('authorize', input())).status).toBe(403);
  });
  it('bounds bodies and rejects unknown identity configuration', async () => {
    const { post } = setup();
    expect((await post('authorize', { ...input(), identity: { ...identity(), approved: true } })).status).toBe(400);
    expect((await post('authorize', { ...input(), padding: 'x'.repeat(17000) })).status).toBe(413);
    expect((await post('authorize', { ...input(), identity: identity({ credential: { ...identity().credential, fingerprint: 'not-a-hash' } }) })).status).toBe(400);
  });
  it('denies unresolved, changed and ambiguous provider identities even when another profile has consent', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0); const { post } = setup();
    for (const changed of [identity({ endpoint: 'https://api.example.invalid/v1/messages' }), identity({ modelId: 'other' }), identity({ harnessVersion: 'other' }), identity({ credential: { ...identity().credential, generation: null } })]) expect((await post('authorize', { ...input(), identity: changed })).status).toBe(503);
    await reviewed(); expect((await post('authorize', input())).status).toBe(503);
  });
  it('denies current managed relay identities until generation and downstream proof exist', async () => {
    await reviewed(); const { post } = setup();
    expect((await post('authorize', { ...input(), binding: { ...binding(), accessSourceId: 'matrix_included' }, identity: identity({ credential: { kind: 'auth_token', fingerprint: 'a'.repeat(64), generation: null } }) })).status).toBe(503);
  });
  it('matches literal beta query only and never broadens or strips actual endpoint identity', async () => {
    await reviewed();
    expect((await resolveGooglePolicyProfile(db.repository, 'owner-one', binding(), identity(), 'mail-assistance')).route.endpoint).toBe(identity().endpoint);
    for (const endpoint of ['https://api.example.invalid/v1/messages?beta=false', 'https://api.example.invalid/v1/messages?beta=true&extra=1', 'https://api.example.invalid/v1/messages?%62eta=true']) await expect(resolveGooglePolicyProfile(db.repository, 'owner-one', binding(), identity({ endpoint }), 'mail-assistance')).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('does not turn database failure into a consent prompt', async () => {
    await reviewed(); const { post } = setup(); vi.spyOn(db.repository, 'snapshot').mockRejectedValueOnce(new Error('synthetic private database error'));
    const response = await post('authorize', input()); expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/synthetic|database|consent_required/);
  });
  it('revalidates only the original owner/account/purpose/route and denies rotation without substitution', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0); const { post } = setup();
    const result = await (await post('authorize', input())).json();
    for (const extra of [{ googleAccountId: generation }, { purposeId: 'other' }, { identity: identity({ credential: { ...identity().credential, fingerprint: 'b'.repeat(64) } }) }]) expect((await post('revalidate', { ...input(), stamp: result.stamp, ...extra })).status).not.toBe(200);
    await db.repository.revokeProfile(profile.id, 'owner-one', 1);
    expect((await post('revalidate', { ...input(), stamp: result.stamp })).status).toBe(503);
  });
  it('roundtrips through the fixed-path server transport without exposing raw errors', async () => {
    const profile = await reviewed(); const { app } = setup();
    const transport = vi.fn(async (_owner: string, request: { path: string; method: 'GET' | 'POST'; body?: Record<string, unknown>; signal: AbortSignal }) => app.request(request.path, { method: request.method, body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' }, signal: request.signal }));
    const client = createGooglePlatformPolicyClient(transport);
    expect(await client.authorize('owner-one', input())).toMatchObject({ status: 'consent_required', consentRevision: 0 });
    await db.repository.recordConsent(consentInput(profile.id), 0);
    const granted = await client.authorize('owner-one', input()); expect(granted.status).toBe('authorized');
    if (granted.status !== 'authorized') throw new Error('Expected authorization');
    expect(await client.revalidate('owner-one', { ...input(), stamp: granted.stamp })).toMatchObject({ stamp: granted.stamp });
    expect(transport.mock.calls.map(call => call[1].path)).toEqual(['/gmail/processing/authorize', '/gmail/processing/authorize', '/gmail/processing/revalidate']);
    expect(transport.mock.calls.every(call => !call[1].signal.aborted)).toBe(true);
  });
  it('rechecks account admission after awaited policy reads before releasing authority', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    const owns = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { post } = setup({ ownsGmailAccount: owns });
    expect((await post('authorize', input())).status).toBe(403);
  });

  it('keeps account admission failures generic after policy reads', async () => {
    const profile = await reviewed(); await db.repository.recordConsent(consentInput(profile.id), 0);
    const owns = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('synthetic private admission error'));
    const response = await setup({ ownsGmailAccount: owns }).post('authorize', input());
    expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/synthetic|admission/);
  });

  it('never substitutes a newly reviewed and consented route for an old stamp', async () => {
    const original = await reviewed(); await db.repository.recordConsent(consentInput(original.id), 0); const { post } = setup();
    const result = await (await post('authorize', input())).json();
    const replacement = await db.repository.reviewProfile({ ...original.input, binding: { ...original.input.binding, credentialFingerprint: 'b'.repeat(64) } }, 0);
    await db.repository.recordConsent(consentInput(replacement.id), 0);
    const response = await post('revalidate', { ...input(), identity: identity({ credential: { ...identity().credential, fingerprint: 'b'.repeat(64) } }), stamp: result.stamp });
    expect(response.status).toBe(503);
  });

  it('does not qualify an HTTP local route under the current HTTPS-only broker adapter', async () => {
    const endpoint = 'http://127.0.0.1:8080/v1/messages';
    const value = profileInput({ endpoint, credentialKind: 'byo', credentialGeneration: generation, harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'], harnessRevision: identity().harnessVersion });
    value.binding.recipientChain[0]!.endpoint = endpoint; await db.repository.reviewProfile(value, 0);
    await expect(resolveGooglePolicyProfile(db.repository, 'owner-one', binding(), identity({ endpoint }), 'mail-assistance')).rejects.toMatchObject({ code: 'unavailable' });
  });

});
