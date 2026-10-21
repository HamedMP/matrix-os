import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import type { BotIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { createGoogleBrokerRuntime } from '../../packages/gateway/src/startup/google-data.js';
import { googleInferenceIdentity } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { createGoogleDataAuthority } from '../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataOwnerRoutes } from '../../packages/gateway/src/google-data/owner-routes.js';
import { createGooglePlatformPolicyRoutes } from '../../packages/gateway/src/google-data/runtime/platform-routes.js';
import type { GoogleCollectionClientDependencies } from '../../packages/gateway/src/google-data/runtime/collection-client.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, profileInput } from './google-data/fixtures.js';

const key = 'synthetic_private_api_key_never_returned';
const generation = '523e4567-e89b-42d3-a456-426614174000';
const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  ownerId: 'owner-one', chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'owner_anthropic_key', anthropicApi: { connectionRevision: 1, credentialGeneration: generation },
  capabilities: ['artifact.read'], requestClass: 'interactive' };
const identity = googleInferenceIdentity(binding, 'https://qualified.example.invalid/exact/v1/messages', { kind: 'api_key', value: key });
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let repository: ReturnType<typeof createGoogleDataRepository>;
let runtime: Awaited<ReturnType<typeof createGoogleBrokerRuntime>>;
let registry: BotRuntimeRegistry;
beforeEach(async () => { ({ db } = await createAuthorityFixture()); registry = new BotRuntimeRegistry(); registry.bind(binding); });
afterEach(async () => { registry.shutdown(); await runtime?.close(); await repository?.close(); await db.destroy(); vi.restoreAllMocks(); });
async function fixture(options: { credentials?: boolean; transport?: boolean } = {}) {
  const now = () => new Date(); repository = createGoogleDataRepository(db.sql, { now });
  const input = profileInput({ credentialKind: 'byo', credentialGeneration: generation, credentialFingerprint: identity.credential.fingerprint,
    endpoint: identity.endpoint, harnessId: GOOGLE_POLICY_HARNESS_ID[identity.api], harnessRevision: identity.harnessVersion,
    recipientChain: [{ recipientId: 'example-provider', accountId: 'verified-account-map', endpoint: identity.endpoint }] });
  input.dataKinds = ['gmail-metadata', 'gmail-content', 'gmail-attachments', 'google-derived-context'];
  input.evidence.expiresAt = new Date(Date.now() + 7200000).toISOString();
  const profile = await repository.reviewProfile(input, 0);
  const owns = async (owner: string, account: string) => owner === binding.ownerId && account === accountId;
  const app = new Hono();
  app.route('/', createGooglePlatformPolicyRoutes({ repository, now, resolveRuntime: async () => ({ ownerId: binding.ownerId, machineId: 'synthetic' }), ownsGmailAccount: owns }));
  app.route('/', createGoogleDataOwnerRoutes({ repository, authority: createGoogleDataAuthority(repository, { now }), now,
    resolveOwner: async () => binding.ownerId, ownsGoogleAccount: owns }));
  const transport: BotIntegrationTransport = vi.fn(async (_owner, request) => app.request(request.path, { method: request.method,
    headers: { 'content-type': 'application/json' }, ...(request.body ? { body: JSON.stringify(request.body) } : {}), signal: request.signal }));
  const credentials = { revalidate: vi.fn(async () => true), credential: vi.fn(async () => key) };
  runtime = await createGoogleBrokerRuntime({ database: db.sql, registry,
    ...(options.credentials === false ? {} : { credentials }), ...(options.transport === false ? {} : { transport }) });
  const requestConsent = vi.fn<GoogleCollectionClientDependencies['requestConsent']>(async () => true);
  const observe = (observed = identity, candidate = binding) => runtime.inference.authorize({ phase: 'dispatch', binding: candidate,
    identity: observed, signal: new AbortController().signal });
  const prepare = (signal = new AbortController().signal) => runtime.prepareCollection(binding, accountId, signal, requestConsent);
  return { transport, credentials, requestConsent, observe, prepare, profile };
}
describe('live broker collection composition', () => {
  it('uses a privately observed endpoint plus fresh broker credentials to get consent and durably classify before collection', async () => {
    const f = await fixture(); await f.observe(); const claim = await f.prepare();
    expect(claim).toMatchObject({ ownerId: binding.ownerId, googleAccountId: accountId, profileId: f.profile.id, consentRevision: 1 });
    expect(f.credentials.credential.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.credentials.revalidate.mock.calls.length).toBeGreaterThan(f.credentials.credential.mock.calls.length);
    expect(f.credentials.credential).toHaveBeenCalledWith(binding, expect.any(AbortSignal));
    expect(f.requestConsent).toHaveBeenCalledOnce();
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toMatchObject({ availability: 'available' });
    const wire = JSON.stringify([claim, runtime.observedIdentity(binding), f.requestConsent.mock.calls,
      vi.mocked(f.transport).mock.calls.map(([, request]) => request.body)]);
    expect(wire).not.toContain(key);
    expect(f.requestConsent.mock.calls[0]![0]).not.toHaveProperty('credential');
  });
  it.each(['observation', 'credentials', 'transport'] as const)('denies missing %s without changing ordinary inference', async absent => {
    const f = await fixture({ credentials: absent !== 'credentials', transport: absent !== 'transport' });
    if (absent !== 'observation') expect(await f.observe()).toEqual({ allowed: true, googleOrigin: false });
    await expect(f.prepare()).rejects.toThrow('Google data processing unavailable');
    expect(f.requestConsent).not.toHaveBeenCalled(); expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it.each(['key', 'generation', 'endpoint', 'api', 'harness', 'revalidation'] as const)('denies stale %s identity before offering consent', async changed => {
    const f = await fixture(); let observed = structuredClone(identity);
    if (changed === 'key') f.credentials.credential.mockResolvedValue('rotated_key');
    if (changed === 'generation') observed.credential.generation = '623e4567-e89b-42d3-a456-426614174000';
    if (changed === 'endpoint') observed.endpoint = 'https://changed.example.invalid/v1/messages';
    if (changed === 'api') observed.api = 'openai-responses';
    if (changed === 'harness') observed.harnessVersion = 'stale-build';
    if (changed === 'revalidation') f.credentials.revalidate.mockResolvedValue(false);
    await f.observe(observed); await expect(f.prepare()).rejects.toThrow('Google data processing unavailable');
    expect(f.requestConsent).not.toHaveBeenCalled(); expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it.each(['cancel', 'rebind', 'rotate', 'observation'] as const)('rechecks the live run after credential lookup waits across %s', async change => {
    const f = await fixture(); await f.observe(); let release!: (value: string) => void;
    f.credentials.credential.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = f.prepare(); const rejected = expect(pending).rejects.toThrow('Google data processing unavailable');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (change === 'cancel') registry.cancelInference(binding);
    if (change === 'rebind') registry.bind(binding);
    if (change === 'observation') await f.observe({ ...identity, endpoint: 'https://changed.example.invalid/v1/messages' });
    release(change === 'rotate' ? 'new_key' : key); await rejected;
    expect(f.requestConsent).not.toHaveBeenCalled(); expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it('rechecks fresh credentials after authenticated owner interaction before recording consent', async () => {
    const f = await fixture(); await f.observe(); f.requestConsent.mockImplementation(async () => { f.credentials.credential.mockResolvedValue('rotated_during_ui'); return true; });
    await expect(f.prepare()).rejects.toThrow('Google data processing unavailable');
    expect(vi.mocked(f.transport).mock.calls.some(([, request]) => request.path === '/gmail/processing-consents')).toBe(false);
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it('denies managed relay evidence without reading or hashing a leased token', async () => {
    const f = await fixture(); const managed = { ...binding, accessSourceId: 'matrix_included' as const, anthropicApi: undefined };
    registry.bind(managed); const observed = googleInferenceIdentity(managed, 'https://relay.example.invalid/v1/messages', { kind: 'auth_token', value: 'leased_token' });
    expect(await f.observe(observed, managed)).toEqual({ allowed: true, googleOrigin: false });
    await expect(runtime.prepareCollection(managed, accountId, new AbortController().signal, f.requestConsent)).rejects.toThrow('Google data processing unavailable');
    expect(f.credentials.credential).not.toHaveBeenCalled(); expect(f.requestConsent).not.toHaveBeenCalled();
  });
  it('aborts a pending owner interaction on close and refuses new collection admission', async () => {
    const f = await fixture(); await f.observe(); let finish!: (value: boolean) => void;
    f.requestConsent.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const pending = f.prepare(); const rejected = expect(pending).rejects.toThrow('Google data processing unavailable');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); await runtime.close(); await rejected;
    finish(true); await expect(f.prepare()).rejects.toThrow('Google data processing unavailable');
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it('caps concurrent collection admission and releases accepted owner interactions on close', async () => {
    const f = await fixture(); await f.observe(); const finish: Array<(value: boolean) => void> = [];
    f.requestConsent.mockImplementation(() => new Promise<boolean>(resolve => { finish.push(resolve); }));
    const accepted = Array.from({ length: 32 }, () => f.prepare());
    const settled = Promise.allSettled(accepted);
    await vi.waitFor(() => expect(finish).toHaveLength(32));
    await expect(f.prepare()).rejects.toThrow('Google data processing unavailable');
    expect(finish).toHaveLength(32); await runtime.close();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    finish.forEach(resolve => resolve(true));
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toBeNull();
  });
  it('drains actual accepted classification SQL even when cancellation returns before the lock wait settles', async () => {
    const f = await fixture(); await f.observe(); const original = runtime.contexts.mark;
    let markStarted!: () => void; const started = new Promise<void>(resolve => { markStarted = resolve; });
    vi.spyOn(runtime.contexts, 'mark').mockImplementation(input => { markStarted(); return original(input); });
    let close!: Promise<void>; let closed = false;
    await db.sql.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try {
        const pending = f.prepare(); const denied = expect(pending).rejects.toThrow('Google data processing unavailable');
        await started;
        close = runtime.close().then(() => { closed = true; });
        await denied; await new Promise(resolve => setTimeout(resolve, 15));
        expect(closed).toBe(false);
      } finally { await sql`SELECT pg_advisory_unlock(551035504)`.execute(held); }
    });
    await close; expect(closed).toBe(true);
    // The accepted metadata write can finish conservatively; the cancelled caller receives no collection claim.
    expect(await runtime.contexts.inspect(binding.ownerId, binding.chatId)).toMatchObject({ availability: 'available' });
    expect(await repository.listReviewedProfiles(binding.ownerId)).toHaveLength(1);
  });
});
