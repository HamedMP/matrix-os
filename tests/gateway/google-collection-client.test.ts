import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import type { BotIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { createGoogleDataAuthority } from '../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataOwnerRoutes } from '../../packages/gateway/src/google-data/owner-routes.js';
import { createGooglePlatformPolicyRoutes } from '../../packages/gateway/src/google-data/runtime/platform-routes.js';
import { createGooglePlatformPolicyClient } from '../../packages/gateway/src/google-data/runtime/platform-client.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleRunPinStore } from '../../packages/gateway/src/google-data/runtime/run-pins.js';
import { createGoogleRuntimeInferenceAuthority } from '../../packages/gateway/src/google-data/runtime/runtime-authority.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { createGoogleCollectionClient, GoogleCollectionClientError, type GoogleCollectionClientDependencies } from '../../packages/gateway/src/google-data/runtime/collection-client.js';
import { createGoogleOwnerConsentClient } from '../../packages/gateway/src/google-data/runtime/owner-consent-client.js';
import type { GoogleInferenceIdentity } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, consentInput, profileInput } from './google-data/fixtures.js';

const kinds = ['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'] as const;
const generation = '523e4567-e89b-42d3-a456-426614174000';
const binding = (): ManagedPiRuntimeBinding => ({ kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'owner_anthropic_key', anthropicApi: { connectionRevision: 1, credentialGeneration: generation }, capabilities: ['artifact.read'], requestClass: 'interactive' });
const identity = (): GoogleInferenceIdentity => ({ endpoint: 'https://api.example.invalid/v1/messages', api: 'anthropic-messages', modelId: 'model-a',
  harnessVersion: 'reviewed-build-1', credential: { kind: 'api_key', fingerprint: 'a'.repeat(64), generation } });
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let repository: ReturnType<typeof createGoogleDataRepository>;
let registry: BotRuntimeRegistry;
let pins: ReturnType<typeof createGoogleRunPinStore>;
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { registry?.shutdown(); await pins?.close(); await repository?.close(); await db.destroy(); vi.restoreAllMocks(); });

async function fixture(options: { granted?: boolean; none?: boolean; limited?: boolean; retentionSeconds?: number } = {}) {
  let clock = new Date(); const now = () => clock; const future = (ms: number) => new Date(clock.getTime() + ms).toISOString();
  repository = createGoogleDataRepository(db.sql, { now }); registry = new BotRuntimeRegistry(); registry.bind(binding());
  const contexts = createGoogleContextStore(db.sql, { now }); pins = createGoogleRunPinStore(db.sql); await contexts.migrate(); await pins.migrate();
  const input = profileInput({ credentialKind: 'byo', credentialGeneration: generation, harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'] });
  input.dataKinds = options.limited ? ['gmail-metadata'] : [...kinds]; input.evidence.expiresAt = future(7200000);
  if (options.retentionSeconds) input.retention.maxAgeSeconds = options.retentionSeconds;
  if (options.none) input.retention = { revision: 1, policyId: 'no-save', mode: 'none', maxAgeSeconds: 0 } as never;
  const profile = await repository.reviewProfile(input, 0);
  const consentValue = () => consentInput(profile.id, { dataKinds: input.dataKinds, expiresAt: future(3600000) });
  if (options.granted) await repository.recordConsent(consentValue(), 0);
  const owns = async (owner: string, account: string) => owner === 'owner-one' && account === accountId;
  const app = new Hono();
  app.route('/', createGooglePlatformPolicyRoutes({ repository, now, resolveRuntime: async () => ({ ownerId: 'owner-one', machineId: 'synthetic' }), ownsGmailAccount: owns }));
  app.route('/', createGoogleDataOwnerRoutes({ repository, authority: createGoogleDataAuthority(repository, { now }), now,
    resolveOwner: async () => 'owner-one', ownsGoogleAccount: owns }));
  // Synthetic transport composes real owner/central routes and SQL. It does not qualify production authentication.
  const transport: BotIntegrationTransport = vi.fn(async (_owner, request) => app.request(request.path, { method: request.method,
    headers: { 'content-type': 'application/json' }, ...(request.body ? { body: JSON.stringify(request.body) } : {}), signal: request.signal }));
  const policyClient = createGooglePlatformPolicyClient(transport); const ownerConsentClient = createGoogleOwnerConsentClient(transport);
  const requestConsent = vi.fn<GoogleCollectionClientDependencies['requestConsent']>(async () => true); let observed: GoogleInferenceIdentity | null = identity();
  const resolveIdentity = vi.fn(async () => observed);
  const deps: GoogleCollectionClientDependencies = { registry, contexts, pins, policyClient, ownerConsentClient, resolveIdentity, requestConsent, now };
  const make = (extra: Partial<GoogleCollectionClientDependencies> = {}) => createGoogleCollectionClient({ ...deps, ...extra });
  const prepare = (extra: Partial<GoogleCollectionClientDependencies> = {}, signal = new AbortController().signal) => make(extra).prepare(binding(), accountId, signal);
  const runtime = () => createGoogleRuntimeInferenceAuthority({ registry, contexts, pins, policyClient, now });
  return { now, future, input, profile, consentValue, contexts, policyClient, ownerConsentClient, requestConsent, resolveIdentity, transport, deps, make, prepare, runtime,
    rotate: () => { observed = { ...identity(), credential: { ...identity().credential, fingerprint: 'd'.repeat(64) } }; },
    missing: () => { observed = null; }, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('trusted Google collection client', () => {
  it.each(['native', 'pipedream'])('gets affirmative owner consent then marks the canonical %s account before returning a private claim', async () => {
    const f = await fixture(); const claim = await f.prepare();
    expect(claim).toMatchObject({ ownerId: 'owner-one', googleAccountId: accountId, profileId: f.profile.id, profileRevision: 1, consentRevision: 1 });
    const context = await f.contexts.inspect('owner-one', 'chat_one');
    expect(context?.sources[0]).toMatchObject({ googleAccountId: accountId, consentId: claim.consentId, profileId: claim.profileId });
    expect(Date.parse(context!.retentionDeadline)).toBe(Date.parse(claim.policyExpiresAt)); // evidence expires before published 1-day retention
    expect(f.requestConsent).toHaveBeenCalledOnce();
    const notice = f.requestConsent.mock.calls[0]![0];
    expect(notice).toEqual({ disclosure: expect.objectContaining({ dataKinds: [...kinds], retention: f.input.retention,
      recipients: f.input.disclosure.recipients, purpose: f.input.disclosure.purpose }), expiresAt: claim.policyExpiresAt });
    expect(JSON.stringify(notice)).not.toMatch(/fingerprint|runtimeHandle|verified-account-map|endpoint|routeDigest|owner-one/);
    const post = vi.mocked(f.transport).mock.calls.find(([, r]) => r.path === '/gmail/processing-consents')![1];
    expect(post.body).toMatchObject({ connectionId: accountId, accepted: true, expectedConsentRevision: 0 });
    expect(post.body).not.toHaveProperty('ownerId'); expect(post.body).not.toHaveProperty('route');
  });
  it('uses existing exact consent without prompting and bounds retention by the existing expiry', async () => {
    const f = await fixture({ granted: true }); const claim = await f.prepare();
    expect(f.requestConsent).not.toHaveBeenCalled(); expect((await f.contexts.inspect('owner-one', 'chat_one'))?.retentionDeadline).toBe(claim.policyExpiresAt);
  });
  it.each(['context', 'pin'] as const)('rechecks %s expiry after the final awaited identity lookup', async expired => {
    const f = await fixture({ granted: true, retentionSeconds: expired === 'context' ? 60 : 3600 });
    await f.prepare();
    if (expired === 'pin') {
      expect(await f.runtime().authorize({ phase: 'dispatch', binding: binding(), identity: identity(), signal: new AbortController().signal })).toMatchObject({ allowed: true });
      const originalGet = pins.get.bind(pins);
      vi.spyOn(pins, 'get').mockImplementation(async b => { const value = await originalGet(b); return value ? { ...value, expiresAt: f.future(60000) } : null; });
    }
    let reads = 0;
    f.resolveIdentity.mockImplementation(async () => { if (++reads === 4) f.advance(60001); return identity(); });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
  });
  it('uses the published duration rather than an invented shorter retention when consent is longer', async () => {
    const f = await fixture({ granted: true, retentionSeconds: 60 });
    // The actual reviewed profile supplies this duration. No caller-selected retention parameter exists.
    await f.prepare(); expect(Date.parse((await f.contexts.inspect('owner-one', 'chat_one'))!.retentionDeadline)).toBe(f.now().getTime() + 60000);
  });
  it.each(['false', 'undefined', 'throw'] as const)('refuses nonaffirmative owner UI %s without recording or marking', async answer => {
    const f = await fixture(); f.requestConsent.mockImplementation(async () => { if (answer === 'throw') throw new Error('private detail'); return answer === 'false' ? false : undefined as never; });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
    expect(await f.contexts.inspect('owner-one', 'chat_one')).toBeNull();
    expect(vi.mocked(f.transport).mock.calls.some(([, r]) => r.path === '/gmail/processing-consents')).toBe(false);
  });
  it('does not let a callback mutate the private notice or consent proposal', async () => {
    const f = await fixture(); f.requestConsent.mockImplementation(async (notice: any) => { notice.disclosure.dataKinds.length = 0; notice.expiresAt = '2099-01-01T00:00:00.000Z'; return true; });
    const claim = await f.prepare(); expect(claim.policyExpiresAt).toBe(f.input.evidence.expiresAt);
    expect((vi.mocked(f.transport).mock.calls.find(([, r]) => r.path === '/gmail/processing-consents')![1].body as any).dataKinds).toEqual([...kinds]);
  });
  it.each(['rotation', 'cancel', 'rebind', 'expiry', 'profile'] as const)('denies %s during owner UI without a consent write or context mark', async changed => {
    const f = await fixture(); f.requestConsent.mockImplementation(async () => {
      if (changed === 'rotation') f.rotate(); if (changed === 'cancel') registry.cancelInference(binding());
      if (changed === 'rebind') registry.bind(binding()); if (changed === 'expiry') f.advance(7200001);
      if (changed === 'profile') await repository.revokeProfile(f.profile.id, 'owner-one', 1); return true;
    });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
    expect(await f.contexts.inspect('owner-one', 'chat_one')).toBeNull();
  });
  it.each(['none', 'limited', 'missing', 'unknown'] as const)('fails closed for %s without invoking owner UI or marking', async failure => {
    const f = await fixture({ none: failure === 'none', limited: failure === 'limited' });
    if (failure === 'missing') f.missing(); if (failure === 'unknown') f.rotate();
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
    expect(f.requestConsent).not.toHaveBeenCalled(); expect(await f.contexts.inspect('owner-one', 'chat_one')).toBeNull();
  });
  it('rejects a stale owner CAS rather than replacing a concurrently granted consent', async () => {
    const f = await fixture(); f.requestConsent.mockImplementation(async () => { await repository.recordConsent(f.consentValue(), 0); return true; });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError); expect(await f.contexts.inspect('owner-one', 'chat_one')).toBeNull();
  });
  it('can recollect under a compatible real runtime pin without replacing its original grant', async () => {
    const f = await fixture({ granted: true }); const first = await f.prepare();
    expect(await f.runtime().authorize({ phase: 'dispatch', binding: binding(), identity: identity(), signal: new AbortController().signal })).toEqual({ allowed: true, googleOrigin: true });
    const pin = await pins.get(binding()); expect(pin).not.toBeNull();
    expect(await f.prepare()).toEqual(first); expect(await pins.get(binding())).toEqual(pin);
  });
  it.each(['identity', 'new-account', 'renewal'] as const)('denies incompatible existing pin %s before marking or prompting', async changed => {
    const f = await fixture({ granted: true }); await f.prepare();
    expect(await f.runtime().authorize({ phase: 'dispatch', binding: binding(), identity: identity(), signal: new AbortController().signal })).toMatchObject({ allowed: true });
    const mark = vi.spyOn(f.contexts, 'mark');
    if (changed === 'identity') f.rotate();
    if (changed === 'renewal') { await repository.revokeAccount('owner-one', accountId); await repository.recordConsent(f.consentValue(), 2); }
    const account = changed === 'new-account' ? '223e4567-e89b-42d3-a456-426614174000' : accountId;
    await expect(f.make().prepare(binding(), account, new AbortController().signal)).rejects.toBeInstanceOf(GoogleCollectionClientError);
    expect(mark).not.toHaveBeenCalled(); expect(f.requestConsent).not.toHaveBeenCalled();
  });
  it('does not offer consent renewal inside an already pinned run', async () => {
    const f = await fixture({ granted: true }); await f.prepare();
    expect(await f.runtime().authorize({ phase: 'dispatch', binding: binding(), identity: identity(), signal: new AbortController().signal })).toMatchObject({ allowed: true });
    await repository.revokeAccount('owner-one', accountId); const mark = vi.spyOn(f.contexts, 'mark');
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
    expect(f.requestConsent).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled();
  });
  it('denies an incompatible pin latched while a collection mark is pending', async () => {
    const f = await fixture({ granted: true }); const original = f.contexts.mark.bind(f.contexts);
    vi.spyOn(f.contexts, 'mark').mockImplementationOnce(async value => {
      const first = await original({ ...value, consentId: 'retained_source' });
      expect(await f.runtime().authorize({ phase: 'dispatch', binding: binding(), identity: identity(), signal: new AbortController().signal })).toMatchObject({ allowed: true });
      return original({ ...value, expectedRevision: first.revision });
    });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
  });
  it.each(['consent', 'rotation', 'context', 'cancel'] as const)('withholds claim after %s changes during the durable mark', async changed => {
    const f = await fixture({ granted: true }); const original = f.contexts.mark.bind(f.contexts);
    vi.spyOn(f.contexts, 'mark').mockImplementationOnce(async value => { const marked = await original(value);
      if (changed === 'consent') await repository.revokeAccount('owner-one', accountId);
      if (changed === 'rotation') f.rotate(); if (changed === 'cancel') registry.cancelInference(binding());
      if (changed === 'context') await original({ ...value, googleAccountId: '223e4567-e89b-42d3-a456-426614174000', consentId: 'other_source', expectedRevision: marked.revision });
      return marked;
    });
    await expect(f.prepare()).rejects.toBeInstanceOf(GoogleCollectionClientError);
  });
  it('aborts an unresponsive consent callback promptly and never marks after it finally returns', async () => {
    const f = await fixture(); let finish!: (value: boolean) => void; let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    f.requestConsent.mockImplementation(() => { entered(); return new Promise<boolean>(r => { finish = r; }); });
    const controller = new AbortController(); const result = f.prepare({}, controller.signal); const rejected = expect(result).rejects.toBeInstanceOf(GoogleCollectionClientError);
    await ready; controller.abort(); await rejected; finish(true); await Promise.resolve(); expect(await f.contexts.inspect('owner-one', 'chat_one')).toBeNull();
  });
});
