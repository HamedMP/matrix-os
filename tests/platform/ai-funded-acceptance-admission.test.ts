import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createAiFundedMeteringRepository } from '../../packages/platform/src/ai-funded-metering-repository.js';
import { createFundedModelProbeService } from '../../packages/platform/src/ai-funded-model-probes.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
const model = 'anthropic/claude-sonnet-5';
describe('exact-runtime acceptance admission on actual repository transactions', () => {
  let db: PlatformDB;
  let clock: Date;
  let normal: ReturnType<typeof createAiFundedPolicyRepository>;
  let scoped: ReturnType<typeof createAiFundedPolicyRepository>;
  let identities: Array<{
    ownerId: string;
    machineId: string;
    runtimeSlot: string;
  }>;
  let scope: {
    ownerId: string;
    machineId: string;
    runtimeSlot: string;
    runtimeTokenEpoch: number;
    validThrough: string;
  };
  let leases: Awaited<ReturnType<typeof normal.issueRuntimeCredential>>[];
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date();
    normal = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(clock) });
    await normal.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    identities = [0, 1].map(i => ({ ownerId: 'user_cohort_test', machineId: randomUUID(), runtimeSlot: i === 0 ? 'pr-9999' : 'primary' }));
    leases = [];
    for (const [i, identity] of identities.entries()) {
      await insertUserMachine(db, {
        ...identity, clerkUserId: identity.ownerId, handle: 'cohort-test-' + i, status: 'running', imageVersion: 'test', provisionedAt: clock.toISOString(), activationState: 'authorized', runtimeTokenEpoch: 2
      });
      await normal.setRuntimePolicy({
        identity, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1000, expiresAt: null
      });
      await normal.grantCredit({
        entryId: 'grant-' + i, identity, kind: 'addon_grant', amountMicrousd: 1000, sourceReference: 'offline-fixture'
      });
      leases.push(await normal.issueRuntimeCredential(identity));
    }
    scope = { ...identities[0], runtimeTokenEpoch: 2, validThrough: new Date(clock.getTime() + 60000).toISOString() };
    scoped = createAiFundedPolicyRepository({
      db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(clock), acceptanceScope: scope
    });
  });
  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
  });
  const request = (lease: {
    credential: {
      token: string;
    };
  }, id: string) => ({
    credential: lease.credential.token, requestId: id, modelId: model, maxCostMicrousd: 100, billingMode: 'usage' as const
  });
  it('rejects other funded primary before summary/snapshot/check/authorize/issue side effects', async () => {
    const before = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    await expect(scoped.getRuntimeFundingSummary(identities[1])).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.getCheckoutFundingSummary(identities[1], Date.now() + 5000)).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.checkPolicy({ credential: leases[1].credential.token, modelId: model })).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.authorize(request(leases[1], 'outside'))).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.issueRuntimeCredential(identities[1])).rejects.toMatchObject({ code: 'access_disabled' });
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(before);
    expect(await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute()).toHaveLength(2);
  });
  it.each(['runtime_token_epoch', 'status'] as const)('denies new work after machine %s changes', async (field) => {
    await db.executor.updateTable('user_machines').set(field === 'status' ? { status: 'stopped' } : { runtime_token_epoch: 3 }).where('machine_id', '=', scope.machineId).execute();
    await expect(scoped.authorize(request(leases[0], 'stale'))).rejects.toThrow();
    await expect(scoped.getRuntimeFundingSummary(identities[0])).rejects.toThrow();
    await expect(scoped.checkPolicy({ credential: leases[0].credential.token, modelId: model })).rejects.toThrow();
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toEqual([]);
  });
  it('allows exact current admission, then preserves historical start/auth replay and settlement after expiry', async () => {
    const input = request(leases[0], 'exact');
    const authorized = await scoped.authorize(input);
    const key = { reservationId: authorized.reservation.reservationId, tokenId: leases[0].credential.tokenId };
    const started = await scoped.startReservation(key);
    clock = new Date(Date.parse(scope.validThrough) + 1);
    await expect(scoped.startReservation(key)).resolves.toEqual(started);
    await expect(scoped.authorize(input)).resolves.toEqual(authorized);
    await expect(scoped.authorize(request(leases[0], 'new-expired'))).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.finalizeReservation({ ...key, mode: 'exact', actualCostMicrousd: 5 })).resolves.toMatchObject({ status: 'settled', chargedCostMicrousd: 5 });
    await expect(scoped.revokeRuntimeCredential({ tokenId: key.tokenId, identity: identities[0] })).resolves.toBe(true);
  });
  it('refuses new reserved dispatch after scope expiry and permits exact release', async () => {
    const authorized = await scoped.authorize(request(leases[0], 'reserved'));
    const key = { reservationId: authorized.reservation.reservationId, tokenId: leases[0].credential.tokenId };
    clock = new Date(Date.parse(scope.validThrough) + 1);
    await expect(scoped.startReservation(key)).rejects.toMatchObject({ code: 'access_disabled' });
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').select('status').where('reservation_id', '=', key.reservationId).executeTakeFirst()).toEqual({ status: 'reserved' });
    await expect(scoped.releaseReservation({ ...key, reason: 'pre_upstream_failure' })).resolves.toMatchObject({ status: 'released' });
  });
  it('blocks global cleanup/grants/policy writes through acceptance repositories', async () => {
    await expect(scoped.cleanupExpiredReservations({ limit: 1 })).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] })).rejects.toMatchObject({ code: 'access_disabled' });
    await expect(scoped.grantCredit({
      entryId: 'no-new-grant', identity: identities[0], kind: 'addon_grant', amountMicrousd: 1, sourceReference: 'offline-fixture'
    })).rejects.toMatchObject({ code: 'access_disabled' });
  });
  it('copies the scope at the direct metering factory boundary',async()=>{
    const metering=createAiFundedMeteringRepository({db,credentialHashSecret:'h'.repeat(32),now:()=>new Date(clock),policyFreshnessMs:60000,reservationTtlMs:300000,inFlightTtlMs:600000,acceptanceScope:scope});
    scope.runtimeSlot='primary';scope.machineId=identities[1].machineId;
    await expect(metering.getRuntimeFundingSummary(identities[0])).resolves.toHaveProperty('funding');
    await expect(metering.getRuntimeFundingSummary(identities[1])).rejects.toMatchObject({code:'access_disabled'});
  });
  it('issues a lease only for the exact current runtime and snapshots the immutable configured tuple', async () => {
    await db.executor.updateTable('ai_funded_runtime_policies').set({ next_issue_at: '1970-01-01T00:00:00.000Z' }).where('machine_id', '=', scope.machineId).execute();
    scope.runtimeSlot = 'primary';
    scope.runtimeTokenEpoch = 3;
    await expect(scoped.issueRuntimeCredential(identities[0])).resolves.toMatchObject({ identity: identities[0] });
    expect(await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute()).toHaveLength(3);
  });
  it.each(['epoch', 'expiry'] as const)('rechecks %s after a readiness budget wait before any outbound fetch', async (kind) => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve;
    });
    const budgetPromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>();
    const reserveProbe = vi.fn(async () => {
      entered();
      await budgetPromise;
      return true;
    });
    const service = createFundedModelProbeService({
      db, acceptanceScope: scope, relayBaseUrl: 'https://relay.example.invalid', relayControlToken: 'c'.repeat(32), dailyLimit: 2, minuteLimit: 2, reserveProbe, fetchFn, now: () => new Date(clock)
    });
    const pending = service.probe(model, { runtime: {
        identity: identities[0], runtimeTokenEpoch: 2, globalRevision: 1, runtimeRevision: 1
      } });
    await enteredPromise;
    if (kind === 'epoch')
      await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 3 }).where('machine_id', '=', scope.machineId).execute();
    else
      clock = new Date(Date.parse(scope.validThrough) + 1);
    release();
    expect((await pending).ready).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('guards every generic model probe before cache/inflight/budget and rechecks epoch after waiting', async () => {
    const reserveProbe = vi.fn(async () => true);
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ready: true, priceValidThrough: new Date(clock.getTime() + 3600000).toISOString() }));
    const service = createFundedModelProbeService({
      db, acceptanceScope: scope, relayBaseUrl: 'https://relay.example.invalid', relayControlToken: 'c'.repeat(32), dailyLimit: 2, minuteLimit: 2, reserveProbe, fetchFn, now: () => new Date(clock)
    });
    const runtime = {
      identity: identities[0], runtimeTokenEpoch: 2, globalRevision: 1, runtimeRevision: 1
    };
    expect((await service.probe(model)).ready).toBe(false);
    expect((await service.probe(model, { runtime: { ...runtime, identity: identities[1] } })).ready).toBe(false);
    expect(reserveProbe).not.toHaveBeenCalled();
    expect((await service.probe(model, { runtime })).ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 3 }).where('machine_id', '=', scope.machineId).execute();
    expect((await service.probe(model, { runtime })).ready).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
// Composition uses the same control auth and keeps closure mounted, but never
// mounts global operator/cleanup capabilities on an acceptance tag.
it('wires acceptance composition with operator routes absent and cleanup unmounted', async () => {
  const { createPlatformFundedAiComposition } = await import('../../packages/platform/src/platform-funded-ai.js');
  const { db } = await createTestPlatformDb();
  try {
    const scope = {
      ownerId: 'user_test', machineId: randomUUID(), runtimeSlot: 'pr-9999', runtimeTokenEpoch: 2, validThrough: new Date(Date.now() + 600000).toISOString()
    };
    const env = {
      MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE: JSON.stringify(scope), PLATFORM_BACKGROUND_WORKERS_ENABLED: 'false', MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', AI_RELAY_CONTROL_TOKEN: 'c'.repeat(32), AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32), PLATFORM_SECRET: 'p'.repeat(32)
    };
    const composition = createPlatformFundedAiComposition({
      db, platformSecret: 'p'.repeat(32), env, acceptanceScope: scope
    });
    expect(composition.internalFundedAiOperatorRoutes).toBeUndefined();
    expect((await composition.internalFundedAiRelayRoutes!.request('/reservations/cleanup', { method: 'POST', headers: { authorization: 'Bearer ' + 'c'.repeat(32), 'content-type': 'application/json' }, body: JSON.stringify({ limit: 1 }) })).status).toBe(404);
    expect((await composition.internalFundedAiRelayRoutes!.request('/release', { method: 'POST', headers: { authorization: 'Bearer ' + 'c'.repeat(32), 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  }
  finally {
    await destroyTestPlatformDb(db);
  }
});

it('preserves strict unscoped Jev runtime validation before spending probe budget', async () => {
  const reserveProbe = vi.fn(async () => false);
  const fetchFn = vi.fn<typeof fetch>();
  const credentials = { issueJevProbeCredential: vi.fn(), revokeRuntimeCredential: vi.fn() };
  const service = createFundedModelProbeService({ db: {} as PlatformDB,
    relayBaseUrl: 'https://relay.example.invalid', relayControlToken: 'c'.repeat(32),
    dailyLimit: 2, minuteLimit: 2, reserveProbe, fetchFn, credentials });
  const runtime = { identity: { ownerId: 'user_test', machineId: randomUUID(), runtimeSlot: 'primary' },
    globalRevision: 1, runtimeRevision: 1, extra: 'unknown' };
  expect((await service.probe('typesafe/jev', { runtime })).ready).toBe(false);
  expect(reserveProbe).not.toHaveBeenCalled();
  expect(credentials.issueJevProbeCredential).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
  const { extra: _extra, ...known } = runtime; void _extra;
  expect((await service.probe('typesafe/jev', { runtime: { ...known, runtimeTokenEpoch: 2 } })).ready).toBe(false);
  expect(reserveProbe).toHaveBeenCalledTimes(1);
});

it('retains acceptance read slots after caller abort until the underlying reads settle', async () => {
  const identity = { ownerId: 'user_test', machineId: randomUUID(), runtimeSlot: 'primary' };
  const clock = new Date();
  const scope = { ...identity, runtimeTokenEpoch: 2, validThrough: new Date(clock.getTime() + 60000).toISOString() };
  let finish!: (value: unknown) => void;
  const held = new Promise(resolve => { finish = resolve; });
  const executeTakeFirst = vi.fn(() => held);
  const selectFrom = vi.fn(() => ({ select: () => ({ where: () => ({ executeTakeFirst }) }) }));
  const db = { executor: { selectFrom } } as unknown as PlatformDB;
  const reserveProbe = vi.fn(async () => false);
  const fetchFn = vi.fn<typeof fetch>();
  const service = createFundedModelProbeService({ db, acceptanceScope: scope, now: () => clock,
    relayBaseUrl: 'https://relay.example.invalid', relayControlToken: 'c'.repeat(32), dailyLimit: 2, minuteLimit: 2,
    reserveProbe, fetchFn });
  const runtime = { identity, runtimeTokenEpoch: 2, globalRevision: 1, runtimeRevision: 1 };
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const waiting = controllers.map(controller => service.probe(model, { runtime, signal: controller.signal }));
  await vi.waitFor(() => expect(executeTakeFirst).toHaveBeenCalledTimes(8));
  controllers.forEach(controller => controller.abort());
  expect((await Promise.all(waiting)).every(result => !result.ready)).toBe(true);
  expect((await service.probe(model, { runtime })).ready).toBe(false);
  expect(executeTakeFirst).toHaveBeenCalledTimes(8);
  expect(reserveProbe).not.toHaveBeenCalled();
  finish({ machine_id: identity.machineId, clerk_user_id: identity.ownerId, runtime_slot: identity.runtimeSlot,
    runtime_token_epoch: 2, status: 'running', activation_state: 'authorized', deleted_at: null });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect((await service.probe(model, { runtime })).ready).toBe(false);
  expect(reserveProbe).toHaveBeenCalledTimes(1);
  expect(fetchFn).not.toHaveBeenCalled();
});
