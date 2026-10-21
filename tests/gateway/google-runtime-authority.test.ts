import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { createGooglePlatformPolicyRoutes } from '../../packages/gateway/src/google-data/runtime/platform-routes.js';
import { createGooglePlatformPolicyClient } from '../../packages/gateway/src/google-data/runtime/platform-client.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { createGoogleRunPinStore } from '../../packages/gateway/src/google-data/runtime/run-pins.js';
import { createGoogleRuntimeInferenceAuthority } from '../../packages/gateway/src/google-data/runtime/runtime-authority.js';
import type { GoogleInferenceIdentity } from '../../packages/gateway/src/google-data/runtime/inference-policy.js';
import { accountId, consentInput, profileInput } from './google-data/fixtures.js';

const suite = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const generation = '523e4567-e89b-42d3-a456-426614174000';
const future = (ms = 3600000) => new Date(Date.now() + ms).toISOString();
const binding = (overrides: Partial<ManagedPiRuntimeBinding> = {}): ManagedPiRuntimeBinding => ({
  kind: 'managed_chat', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', ownerId: 'owner-one',
  chatId: 'chat_one', runId: 'run_one', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'c'.repeat(64),
  route: { api: 'anthropic-messages', modelId: 'model-a', input: ['text'], contextWindow: 128000, maxOutputTokens: 8192 },
  accessSourceId: 'owner_anthropic_key', anthropicApi: { connectionRevision: 1, credentialGeneration: generation },
  capabilities: ['artifact.read'], requestClass: 'interactive', ...overrides,
});
const identity = (): GoogleInferenceIdentity => ({ endpoint: 'https://api.example.invalid/v1/messages', api: 'anthropic-messages', modelId: 'model-a',
  harnessVersion: 'reviewed-build-1', credential: { kind: 'api_key', fingerprint: 'a'.repeat(64), generation } });
function defer<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

suite('composed runtime Google context inference authority', () => {
  let db: Kysely<Record<string, never>>; let admin: Kysely<Record<string, never>>; let schema: string;
  let registry: BotRuntimeRegistry; let contexts: ReturnType<typeof createGoogleContextStore>;
  let repository: ReturnType<typeof createGoogleDataRepository>; let pins: ReturnType<typeof createGoogleRunPinStore>;
  let client: ReturnType<typeof createGooglePlatformPolicyClient>;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.includes('test')) throw new Error('Dedicated test database required');
    schema = `runtime_authority_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` }) }) });
    registry = new BotRuntimeRegistry(); registry.bind(binding());
    contexts = createGoogleContextStore(db); repository = createGoogleDataRepository(db); pins = createGoogleRunPinStore(db);
    await contexts.migrate(); await repository.migrate(); await pins.migrate();
    const app = createGooglePlatformPolicyRoutes({ repository, resolveRuntime: async () => ({ ownerId: 'owner-one', machineId: 'synthetic' }), ownsGmailAccount: async owner => owner === 'owner-one' });
    client = createGooglePlatformPolicyClient(async (_owner, request) => app.request(request.path, { method: request.method,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body), signal: request.signal }));
  });
  afterEach(async () => { vi.restoreAllMocks(); registry?.shutdown(); await pins?.close(); await repository?.close(); await db?.destroy();
    if (admin) { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); } });
  const mark = (extra = {}) => contexts.mark({ ownerId: 'owner-one', chatId: 'chat_one', googleAccountId: accountId,
    consentId: 'source_original_consent', profileId: 'source_original_profile', profileRevision: 1, purposeId: 'mail-assistance', expiresAt: future(), retentionDeadline: future(), ...extra });
  async function target(account = accountId) {
    const value = profileInput({ credentialKind: 'byo', credentialGeneration: generation, harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'] });
    value.dataKinds = ['google-derived-context'] as never;
    value.evidence.reviewedAt = new Date(Date.now() - 1000).toISOString(); value.evidence.expiresAt = future(7200000);
    const existing = (await repository.listReviewedProfiles('owner-one'))[0];
    const reviewed = existing ?? await repository.reviewProfile(value, 0);
    const recorded = await repository.recordConsent(consentInput(reviewed.id, { googleAccountId: account, dataKinds: ['google-derived-context'], expiresAt: future() }), 0);
    return { reviewed, recorded };
  }
  function authority() { return createGoogleRuntimeInferenceAuthority({ registry, contexts, pins, policyClient: client }); }
  const request = (phase: 'dispatch' | 'release' = 'dispatch', value = binding()) => ({ phase, binding: value, identity: identity(), signal: new AbortController().signal });
  it('preserves ordinary runs without latching non-Google classification, then admits later explicit taint', async () => {
    const authorize = vi.spyOn(client, 'authorize');
    expect(await authority().authorize(request())).toEqual({ allowed: true, googleOrigin: false });
    expect(await pins.get(binding())).toBeNull(); expect(authorize).not.toHaveBeenCalled();
    await mark(); await target();
    expect(await authority().authorize(request())).toEqual({ allowed: true, googleOrigin: true });
    expect(await pins.get(binding())).not.toBeNull();
  });
  it('does not release an ordinary decision if collection taints the context during a pin lookup', async () => {
    const actual = pins.get.bind(pins);
    vi.spyOn(pins, 'get').mockImplementationOnce(async key => { const result = await actual(key); await mark(); return result; });
    expect(await authority().authorize(request())).toEqual({ allowed: false });
  });
  it('allows retained source lineage on a newly consented target route and revalidates every phase', async () => {
    await mark(); const { reviewed } = await target(); const revalidate = vi.spyOn(client, 'revalidate');
    const gate = authority();
    expect(await gate.authorize(request())).toEqual({ allowed: true, googleOrigin: true });
    expect((await pins.get(binding()))?.stamps[0]?.profileId).toBe(reviewed.id);
    const calls = revalidate.mock.calls.length;
    expect(await gate.authorize(request('release'))).toEqual({ allowed: true, googleOrigin: true });
    expect(revalidate.mock.calls.length).toBeGreaterThan(calls);
    expect((await contexts.inspect('owner-one', 'chat_one'))?.sources[0]?.profileId).toBe('source_original_profile');
  });
  it('denies missing derived-context consent and null identities without latching authority', async () => {
    await mark();
    expect(await authority().authorize(request())).toEqual({ allowed: false });
    await target();
    expect(await authority().authorize({ ...request(), identity: null })).toEqual({ allowed: false });
    expect(await pins.get(binding())).toBeNull();
  });
  it('does not establish a first Google pin during response release', async () => {
    await mark(); await target();
    expect(await authority().authorize(request('release'))).toEqual({ allowed: false });
    expect(await pins.get(binding())).toBeNull();
  });
  it('denies expired and purging saved contexts even when target consent is fresh', async () => {
    await mark(); await target(); await contexts.beginPurge('owner-one', accountId);
    expect(await authority().authorize(request())).toEqual({ allowed: false });
    await sql`UPDATE google_context_markers SET state='active',retention_deadline=now()-interval '1 second'`.execute(db);
    await sql`UPDATE google_context_sources SET state='active'`.execute(db);
    expect(await authority().authorize(request())).toEqual({ allowed: false });
  });
  it('never substitutes a newer consent during an existing Google run', async () => {
    await mark(); const { reviewed, recorded } = await target(); const gate = authority();
    expect(await gate.authorize(request())).toMatchObject({ allowed: true });
    await repository.revokeConsent({ ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: reviewed.id }, recorded.revision);
    await repository.recordConsent(consentInput(reviewed.id, { dataKinds: ['google-derived-context'], expiresAt: future() }), recorded.revision + 1);
    expect(await gate.authorize(request('release'))).toEqual({ allowed: false });
    const next = binding({ runId: 'run_two', executionGeneration: '2' }); registry.bind(next);
    expect(await gate.authorize(request('dispatch', next))).toEqual({ allowed: true, googleOrigin: true });
  });
  it('requires all mixed-account target grants and denies added sources after a Google pin', async () => {
    const first = await mark(); await target(); const gate = authority();
    expect(await gate.authorize(request())).toMatchObject({ allowed: true });
    const other = '223e4567-e89b-42d3-a456-426614174000';
    await mark({ googleAccountId: other, consentId: 'second_source', expectedRevision: first.revision });
    await target(other);
    expect(await gate.authorize(request('release'))).toEqual({ allowed: false });
    const next = binding({ runId: 'run_two', executionGeneration: '2' }); registry.bind(next);
    expect(await gate.authorize(request('dispatch', next))).toEqual({ allowed: true, googleOrigin: true });
    expect((await pins.get(next))?.stamps).toHaveLength(2);
  });
  it.each(['binding', 'abort', 'same_binding_rebind'] as const)('rechecks %s after an awaited context read', async changed => {
    const wait = defer<Awaited<ReturnType<typeof contexts.inspect>>>(); vi.spyOn(contexts, 'inspect').mockReturnValueOnce(wait.promise);
    const call = request(); const cancel = new AbortController(); call.signal = cancel.signal;
    const pending = authority().authorize(call);
    if (changed === 'binding') registry.bind(binding({ executionGeneration: '2' }));
    if (changed === 'same_binding_rebind') registry.bind(binding());
    if (changed === 'abort') cancel.abort();
    wait.resolve(null); expect(await pending).toEqual({ allowed: false });
  });
  it.each(['authorize', 'revalidate'] as const)('denies a registry cancellation while awaiting central %s', async method => {
    await mark(); await target(); const gate = authority();
    if (method === 'revalidate') expect(await gate.authorize(request())).toMatchObject({ allowed: true });
    const original = client[method].bind(client);
    vi.spyOn(client, method).mockImplementationOnce(async (...args: any[]) => {
      const result = await (original as any)(...args); registry.cancelInference(binding()); return result;
    });
    expect(await gate.authorize(request(method === 'revalidate' ? 'release' : 'dispatch'))).toEqual({ allowed: false });
  });
  it('accepts benign same-origin revision changes between phases while keeping target stamps immutable', async () => {
    const first = await mark(); await target(); const gate = authority();
    expect(await gate.authorize(request())).toMatchObject({ allowed: true });
    await mark({ expectedRevision: first.revision });
    expect(await gate.authorize(request('release'))).toEqual({ allowed: true, googleOrigin: true });
  });
  it('rechecks registry while waiting on central policy and detects context purge before release', async () => {
    await mark(); await target();
    const actual = client.authorize.bind(client); vi.spyOn(client, 'authorize').mockImplementationOnce(async (...args) => {
      const result = await actual(...args); await contexts.beginPurge('owner-one', accountId); return result;
    });
    expect(await authority().authorize(request())).toEqual({ allowed: false });
  });
  it('denies changed observed transport or removed classification on an already pinned run', async () => {
    await mark(); await target(); const gate = authority(); expect(await gate.authorize(request())).toMatchObject({ allowed: true });
    expect(await gate.authorize({ ...request('release'), identity: { ...identity(), harnessVersion: 'other' } })).toEqual({ allowed: false });
    vi.spyOn(contexts, 'inspect').mockResolvedValue(null);
    expect(await gate.authorize(request('release'))).toEqual({ allowed: false });
  });
  it('aborts a stalled injected context dependency without waiting for its completion', async () => {
    vi.spyOn(contexts, 'inspect').mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController(); const pending = authority().authorize({ ...request(), signal: controller.signal });
    controller.abort(); expect(await pending).toEqual({ allowed: false });
  });
});
