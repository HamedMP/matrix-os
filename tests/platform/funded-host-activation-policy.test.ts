import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createExpiredUsageWaiver } from '../../packages/platform/src/ai-funded-usage-waiver.js';
import { createHash } from 'node:crypto';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createFundedHostActivationRoutes, readFundedHostActivation } from '../../packages/platform/src/funded-host-activation.js';

const machineId = '12345678-1234-4234-8234-123456789abc';
const secret = 'strong-platform-secret-for-test-only';
const previewSecret = 'separate-preview-secret-for-test';
const at = '2026-10-18T18:00:00.000Z';
const relayOrigin = 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app';
const identity = { handle: 'alice', machineId, runtimeSlot: 'primary' };
describe('permanent funded host activation policy', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId, clerkUserId: 'user_alice', handle: 'alice', runtimeSlot: 'primary', status: 'running', activationState: 'authorized', imageVersion: 'v2026.10.15-1792', runtimeTokenEpoch: 2, provisionedAt: at });
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).where('policy_id', '=', 'default').execute();
    await db.executor.insertInto('ai_funded_runtime_policies').values({ machine_id: machineId, owner_id: 'user_alice', runtime_slot: 'primary', enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']), monthly_budget_microusd: 100, expires_at: null, next_issue_at: at, revision: 1, created_at: at, updated_at: at }).execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const token = (epoch = 2) => buildPlatformRuntimeVerificationToken(identity, secret, epoch);
  const read = (authorization = `Bearer ${token()}`, env: NodeJS.ProcessEnv = {}) => readFundedHostActivation({ db, platformSecret: secret, relayOrigin, handle: 'alice', runtimeSlot: 'primary', authorization, now: () => new Date(at), env });
  it('delivers current configuration without temporary cohorts, grants or credential issuance', async () => {
    const before = await db.executor.selectFrom('user_machines').selectAll().execute();
    const result = await read();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected ready activation');
    expect(result.configuration).toMatchObject({ identity: { ...identity, ownerId: 'user_alice', runtimeTokenEpoch: 2 }, configuration: { enabled: true, platformOrigin: 'https://app.matrix-os.com', relayOrigin, runtimeToken: token() }, issuedAt: at, expiresAt: '2026-10-18T18:00:30.000Z' });
    expect(await db.executor.selectFrom('user_machines').selectAll().execute()).toEqual(before);
    for (const table of ['ai_funded_credit_ledger', 'ai_runtime_credentials', 'ai_funded_usage_reservations', 'ai_funded_runtime_balances'] as const) expect(await db.executor.selectFrom(table).selectAll().execute()).toEqual([]);
  });
  it.each([
    { provisioningClass: 'preview' as const, previewSlot: 'pr-2383' },
    { provisioningClass: 'private-preview' as const, previewSlot: 'pv-2383-deadbeef' },
  ])('delivers an exact live $provisioningClass allocation only with the separate Preview proof secret', async ({ provisioningClass, previewSlot }) => {
    const previewIdentity = { handle: previewSlot, machineId, runtimeSlot: previewSlot };
    await db.executor.updateTable('user_machines').set({
      handle: previewSlot,
      runtime_slot: previewSlot,
      provisioning_class: provisioningClass,
      ...(provisioningClass === 'private-preview'
        ? { source_pr: 2383, confirmed_bundle_version: 'v2026.10.18-pr2383-test' }
        : {}),
    }).where('machine_id', '=', machineId).execute();
    await db.executor.updateTable('ai_funded_runtime_policies').set({
      runtime_slot: previewSlot,
      expires_at: '2026-10-18T19:00:00.000Z',
    }).where('machine_id', '=', machineId).execute();
    await db.executor.insertInto('preview_runtime_allocations').values({
      machine_id: machineId,
      owner_id: 'user_alice',
      runtime_slot: previewSlot,
      runtime_token_epoch: 2,
      ai_budget_microusd: 100,
      ai_request_limit: 2,
      ai_requests_used: 0,
      speech_request_limit: 2,
      speech_requests_used: 0,
      max_concurrency: 1,
      expires_at: '2026-10-18T19:00:00.000Z',
      created_at: at,
      updated_at: at,
    }).execute();
    const previewToken = buildPlatformRuntimeVerificationToken(previewIdentity, previewSecret, 2);
    const readPreview = (authorization: string, configuredSecret: string | null = previewSecret) =>
      readFundedHostActivation({ db, platformSecret: secret,
        ...(configuredSecret !== null ? { previewRuntimeSecret: configuredSecret } : {}),
        relayOrigin, handle: previewSlot, runtimeSlot: previewSlot, authorization,
        now: () => new Date(at) });

    const result = await readPreview(`Bearer ${previewToken}`);
    expect(result).toMatchObject({ status: 'ready', configuration: {
      identity: { ownerId: 'user_alice', machineId, runtimeSlot: previewSlot, runtimeTokenEpoch: 2 },
      configuration: { runtimeToken: previewToken },
    } });
    expect((await readPreview(`Bearer ${buildPlatformRuntimeVerificationToken(previewIdentity, secret, 2)}`)).status)
      .toBe('unauthorized');
    expect((await readPreview(`Bearer ${previewToken}`, null)).status).toBe('unauthorized');
  });
  it.each([() => token(1), () => buildPlatformVerificationToken('alice', secret), () => 'f'.repeat(64)])('rejects stale or differently scoped credentials', async bearer => {
    expect((await read(`Bearer ${bearer()}`)).status).toBe('unauthorized');
  });
  it.each(['global', 'runtime', 'expired', 'models', 'owner', 'preview', 'billing'] as const)('does not activate an ineligible %s', async kind => {
    if (kind === 'global') await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).execute();
    if (kind === 'runtime') await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: false }).execute();
    if (kind === 'expired') await db.executor.updateTable('ai_funded_runtime_policies').set({ expires_at: '2026-10-17T00:00:00.000Z' }).execute();
    if (kind === 'models') await db.executor.updateTable('ai_funded_runtime_policies').set({ allowed_model_ids: '[]' }).execute();
    if (kind === 'owner') await db.executor.updateTable('ai_funded_runtime_policies').set({ owner_id: 'user_other' }).execute();
    if (kind === 'preview') await db.executor.updateTable('user_machines').set({ provisioning_class: 'preview' }).execute();
    if (kind === 'billing') await db.executor.updateTable('user_machines').set({ activation_state: 'awaiting_billing' }).execute();
    expect((await read()).status).not.toBe('ready');
  });
  it.each(['reserved', 'in_flight', 'settled', 'waived'])('defers unresolved %s without modifying financial records', async status => {
    await db.executor.insertInto('ai_runtime_credentials').values({ token_id: 'token_test', token_hash: 'a'.repeat(64), owner_id: 'user_alice', machine_id: machineId, runtime_slot: 'primary', audience: 'matrix-funded-relay', scope: 'ai:invoke', issued_at: at, expires_at: at, revoked_at: null }).execute();
    await db.executor.insertInto('ai_funded_usage_reservations').values({ reservation_id: 'reservation_test', request_id: 'request_test', payload_hash: 'b'.repeat(64), authorization_response: '{}', settlement_response: null, finalization_mode: null, manual_review_evidence_ref: null, manual_review_actor: null, manual_reviewed_at: null, start_response: null, release_response: null, release_reason: null, token_id: 'token_test', owner_id: 'user_alice', machine_id: machineId, runtime_slot: 'primary', model_id: 'anthropic/claude-sonnet-5', reserved_microusd: 1, promotional_reserved_microusd: null, addon_reserved_microusd: null, actual_microusd: null, resolved_model: null, pricing_version: null, period_start: at, status, charge_waiver: status === 'waived' ? '{}' : null, created_at: at, started_at: null, expires_at: at, settled_at: null, released_at: null }).execute();
    const before = await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute();
    if (status === 'waived') await expect(read()).rejects.toMatchObject({ code: 'idempotency_conflict' });
    else expect((await read()).status).toBe('deferred');
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toEqual(before);
  });
  it.each(['scheduled', 'processing', 'completed'])('defers an owner with %s deletion while preserving their job', async status => {
    const deletionSecret = 'existing-account-deletion-secret-test-only';
    const repository = new AccountDeletionRepository(db.kysely, { secret: deletionSecret, now: () => new Date(at) });
    await repository.accept({ clerkUserId: 'user_alice', appleTokens: [] }, false);
    await db.executor.updateTable('account_deletion_jobs').set({ status }).execute();
    const before = await db.executor.selectFrom('account_deletion_jobs').selectAll().execute();
    expect((await read(undefined, { ACCOUNT_DELETION_SECRET: deletionSecret })).status).toBe('deferred');
    expect(await db.executor.selectFrom('account_deletion_jobs').selectAll().execute()).toEqual(before);
  });
  it('accepts a valid prior waiver without changing any existing financial state and rejects a damaged audit', async () => {
    const owner = { ownerId: 'user_alice', machineId, runtimeSlot: 'primary' as const };
    let clock = new Date('2026-10-18T17:00:00.000Z');
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(clock), credentialTtlMs: 3_600_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
    await repo.setRuntimePolicy({ identity: owner, expectedRevision: 1, enabled: true, allowedModelIds: ['anthropic/claude-sonnet-5'], monthlyBudgetMicrousd: 100, expiresAt: null });
    await repo.grantCredit({ entryId: 'activation-test-grant', identity: owner, kind: 'promotional_grant', amountMicrousd: 100, sourceReference: 'fixture', expiresAt: '2026-10-19T00:00:00.000Z' });
    await db.executor.updateTable('ai_funded_runtime_policies').set({ next_issue_at: clock.toISOString() }).execute();
    const credential = (await repo.issueRuntimeCredential(owner)).credential;
    const authorized = await repo.authorize({ credential: credential.token, requestId: 'activation-test-request', modelId: 'anthropic/claude-sonnet-5', maxCostMicrousd: 100, billingMode: 'usage' });
    await repo.startReservation({ reservationId: authorized.reservation.reservationId, tokenId: credential.tokenId });
    const row = await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().executeTakeFirstOrThrow();
    clock = new Date(at);
    await createExpiredUsageWaiver({ db, now: () => new Date(clock) })({ identity: owner, expectedRuntimeTokenEpoch: 2, accountDeletionMode: 'disabled', reviewer: 'operator:test', evidenceRef: 'test:activation', reason: 'expired_unknown_usage', acceptPlatformLiability: true, expectedReleasedMicrousd: 100, expectedMaximumLiabilityMicrousd: 100, reservations: [{ reservationId: row.reservation_id, tokenId: row.token_id, requestId: row.request_id, startedAt: row.started_at!, expiresAt: row.expires_at, reservedMicrousd: 100, promotionalReservedMicrousd: 100, addonReservedMicrousd: 0, maximumLiabilityMicrousd: 100, authorizationSha256: createHash('sha256').update(row.authorization_response).digest('hex'), fundingAllocationSha256: createHash('sha256').update(JSON.stringify([{ grantEntryId: 'activation-test-grant', amountMicrousd: 100 }])).digest('hex'), executionAdmissionReleaseSha256: null }] }, { apply: true });
    const snapshot = async () => ({ reservations: await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute(), balances: await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute(), ledger: await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute(), credentials: await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute() });
    const before = await snapshot();
    expect((await read()).status).toBe('ready');
    expect(await snapshot()).toEqual(before);
    await db.executor.updateTable('ai_funded_usage_reservations').set({ charge_waiver: '{}' }).execute();
    await expect(read()).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('mounts a strict no-store GET route and rejects arbitrary query/slot input', async () => {
    const app = new Hono().route('/internal/containers/:handle/ai', createFundedHostActivationRoutes({ db, platformSecret: secret, relayOrigin, now: () => new Date(at) }));
    const path = '/internal/containers/alice/ai/activation-config';
    const headers = { authorization: `Bearer ${token()}` };
    const response = await app.request(path + '?runtimeSlot=primary', { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).identity.machineId).toBe(machineId);
    expect((await app.request(path + '?runtimeSlot=pr-1', { headers })).status).toBe(401);
    expect((await app.request(path + '?runtimeSlot=primary&origin=https://evil.example', { headers })).status).toBe(400);
    expect((await app.request(path)).status).toBe(401);
  });
});
