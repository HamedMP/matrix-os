import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  admitDailyFundedSpend,
  readDailyFundedSpend,
  utcDayStart,
} from '../../packages/platform/src/free-tier/capacity.js';
import { loadFreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import type { ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import { loadContainerSubstrateConfig } from '../../packages/platform/src/substrates/container-substrate-config.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const NOW = new Date('2026-11-12T15:00:00.000Z');

/** A provider that never answers: the start claim is what these tests observe. */
function idleProvider(): ContainerProvider {
  const never = () => new Promise<never>(() => undefined);
  return {
    run: never, describe: async () => null, resume: never, suspend: never, terminate: async () => undefined,
    list: async () => [], mintEndpointCredential: never,
  };
}

async function addContainer(db: PlatformDB, index: number, status: string) {
  const machineId = `ctr-cap-${index}`;
  await insertUserMachine(db, {
    machineId, clerkUserId: `user_cap${index}`, handle: `cap${index}`, status,
    imageVersion: null, provisionedAt: NOW.toISOString(), substrate: 'container', activationState: 'authorized',
  });
  return machineId;
}

const statusOf = async (db: PlatformDB, machineId: string) => (await db.executor.selectFrom('user_machines')
  .select('status').where('machine_id', '=', machineId).executeTakeFirstOrThrow()).status;

describe('running container ceiling', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const lifecycle = (maxRunning?: number) => createContainerLifecycleService({
    db, provider: idleProvider(), buildBootPayload: async () => '{}', now: () => NOW,
    ...(maxRunning === undefined ? {} : { maxRunning }),
  });

  it('answers busy for a stopped runtime once the running ceiling is reached, without claiming it', async () => {
    await addContainer(db, 1, 'running');
    await addContainer(db, 2, 'quiescing');
    const stopped = await addContainer(db, 3, 'stopped');
    expect(await lifecycle(2).ensureStarted(stopped)).toEqual({ state: 'busy' });
    expect(await statusOf(db, stopped)).toBe('stopped');
  });

  it('starts a runtime below the ceiling and still serves one that is already running at it', async () => {
    const running = await addContainer(db, 1, 'running');
    const stopped = await addContainer(db, 2, 'stopped');
    const service = lifecycle(2);
    expect(await service.ensureStarted(stopped)).toEqual({ state: 'starting' });
    expect(await statusOf(db, stopped)).toBe('starting');
    expect(await service.ensureStarted(running)).toEqual({ state: 'running' });
  });

  it('keeps counting a runtime whose stop could not confirm its unit suspended, until that unit must have ended', async () => {
    const failing = await addContainer(db, 1, 'running');
    await db.executor.updateTable('user_machines').set({ substrate_ref: 'mvm-cap-1', started_at: NOW, status_changed_at: NOW })
      .where('machine_id', '=', failing).execute();
    let clock = NOW;
    const service = createContainerLifecycleService({
      db, buildBootPayload: async () => '{}', now: () => clock, maxRunning: 1, logError: () => undefined,
      provider: {
        ...idleProvider(), run: async () => { throw new Error('unused'); }, suspend: async () => { throw new Error('provider down'); },
      },
    });
    expect(await service.stop(failing, 1, AbortSignal.timeout(5_000))).toBe('needs_recovery');
    const stopped = await addContainer(db, 2, 'stopped');
    const whileUncertain = await service.ensureStarted(stopped);
    await service.drain();
    expect(whileUncertain).toEqual({ state: 'busy' });

    clock = new Date(NOW.getTime() + 8 * 3_600_000 + 1);
    const afterLifetime = await service.ensureStarted(stopped);
    await service.drain();
    expect(afterLifetime).toEqual({ state: 'starting' });
  });

  it('frees the slot of a failed stop whose unit was confirmed suspended', async () => {
    const recovered = await addContainer(db, 1, 'quiescing');
    await db.executor.updateTable('user_machines').set({ substrate_ref: 'mvm-cap-1', started_at: NOW, status_changed_at: NOW })
      .where('machine_id', '=', recovered).execute();
    const service = createContainerLifecycleService({
      db, buildBootPayload: async () => '{}', now: () => NOW, maxRunning: 1, logError: () => undefined,
      provider: { ...idleProvider(), run: async () => { throw new Error('unused'); }, suspend: async () => undefined },
    });
    expect(await service.recoverAfterFailedStop(recovered, 1, 'flush_failed', AbortSignal.timeout(5_000))).toBe(true);
    expect(await statusOf(db, recovered)).toBe('needs_recovery');
    const started = await service.ensureStarted(await addContainer(db, 2, 'stopped'));
    await service.drain();
    expect(started).toEqual({ state: 'starting' });
  });

  it('does not count runtimes on a VPS or ones without compute', async () => {
    await insertUserMachine(db, {
      machineId: 'vps-cap', clerkUserId: 'user_capvps', handle: 'capvps', status: 'running',
      imageVersion: 'b1', provisionedAt: NOW.toISOString(),
    });
    await addContainer(db, 1, 'stopped');
    await addContainer(db, 2, 'needs_recovery');
    const stopped = await addContainer(db, 3, 'stopped');
    expect(await lifecycle(1).ensureStarted(stopped)).toEqual({ state: 'starting' });
  });
});

describe('ceiling settings', () => {
  const container = {
    MATRIX_CONTAINER_SUBSTRATE_ENABLED: 'true',
    MATRIX_CONTAINER_REGION: 'eu-central-1',
    MATRIX_CONTAINER_IMAGE: 'image',
    MATRIX_CONTAINER_INGRESS_CONNECTORS: 'in-1',
    MATRIX_CONTAINER_EGRESS_CONNECTORS: 'out-1',
    MATRIX_CONTAINER_OWNER_DB_ADMIN_URL: 'postgresql://admin@db.internal/postgres',
    MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST: 'db.internal',
    MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET: 'p'.repeat(40),
    MATRIX_CONTAINER_PLATFORM_URL: 'https://platform.internal',
    PLATFORM_SECRET: 'x'.repeat(40),
  };

  it('derives the running ceiling from the owner cluster connection budget', () => {
    const loaded = loadContainerSubstrateConfig({ ...container, MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET: '100' });
    expect(loaded.ok && loaded.config.maxRunning).toBe(20);
  });

  it('refuses a running ceiling whose connections exceed the budget, by setting name', () => {
    expect(loadContainerSubstrateConfig({
      ...container, MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET: '100', MATRIX_CONTAINER_MAX_RUNNING: '21',
    })).toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_CONTAINER_MAX_RUNNING'] });
  });

  it('reads an optional daily funded spend ceiling for free runtimes', () => {
    const base = { MATRIX_FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '10' };
    expect(loadFreeTierConfig({ ...base, MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: '5000000' }))
      .toMatchObject({ ok: true, config: { dailyFundedSpendMicrousd: 5_000_000 } });
    expect(loadFreeTierConfig({ ...base, MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: '0' }))
      .toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD'] });
  });
});

/** One free runtime with a credential, so each reservation sits on its own owner. */
async function seedFreeOwner(db: PlatformDB, label: string, provisioningClass: 'free' | 'customer' = 'free') {
  const machineId = `ctr-spend-${label}`;
  const owner = `user_spend${label}`;
  await insertUserMachine(db, {
    machineId, clerkUserId: owner, handle: `spend${label}`, status: 'running', imageVersion: null,
    provisionedAt: NOW.toISOString(),
    ...(provisioningClass === 'free' ? { substrate: 'container' as const } : {}),
    activationState: 'authorized',
  });
  const tokenId = `tok-${label}`;
  await sql`INSERT INTO ai_runtime_credentials
    (token_id, token_hash, owner_id, machine_id, runtime_slot, audience, scope, issued_at, expires_at)
    VALUES (${tokenId}, ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, ${owner}, ${machineId}, 'primary',
      'matrix-funded-relay', 'ai:invoke', ${NOW.toISOString()}, ${new Date(NOW.getTime() + 3_600_000).toISOString()})`
    .execute(db.executor);
  return { machineId, owner, tokenId };
}

async function insertReservation(executor: PlatformDB['executor'], seeded: { machineId: string; owner: string; tokenId: string }, input: {
  reserved: number; actual?: number | null; status: string; createdAt: Date;
}) {
  await sql`INSERT INTO ai_funded_usage_reservations
    (reservation_id, request_id, payload_hash, authorization_response, token_id, owner_id, machine_id, runtime_slot,
     model_id, reserved_microusd, actual_microusd, period_start, status, created_at, expires_at)
    VALUES (${randomUUID()}, ${randomUUID()}, ${'a'.repeat(64)}, '{}', ${seeded.tokenId}, ${seeded.owner}, ${seeded.machineId},
      'primary', 'model', ${input.reserved}, ${input.actual ?? null}, '2026-11-01', ${input.status},
      ${input.createdAt.toISOString()}, ${new Date(input.createdAt.getTime() + 600_000).toISOString()})`.execute(executor);
}

describe('daily funded spend of free runtimes', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("reads today's free-runtime spend from the funded reservation ledger", async () => {
    const free = await seedFreeOwner(db, 'a');
    const paid = await seedFreeOwner(db, 'b', 'customer');
    const today = new Date('2026-11-12T01:00:00.000Z');
    await insertReservation(db.executor, free, { reserved: 500, actual: 120, status: 'settled', createdAt: today });
    await insertReservation(db.executor, free, { reserved: 300, actual: null, status: 'released', createdAt: today });
    await insertReservation(db.executor, free, { reserved: 200, actual: null, status: 'expired', createdAt: today });
    await insertReservation(db.executor, free, { reserved: 900, status: 'settled', actual: 900, createdAt: new Date('2026-11-11T23:59:59.000Z') });
    await insertReservation(db.executor, paid, { reserved: 10_000, actual: 10_000, status: 'settled', createdAt: today });
    expect(utcDayStart(NOW)).toBe('2026-11-12T00:00:00.000Z');
    expect(await readDailyFundedSpend(db.executor, NOW)).toBe(320);
  });

  it('admits a hold only while it fits under the ceiling', async () => {
    const free = await seedFreeOwner(db, 'c');
    await insertReservation(db.executor, free, { reserved: 700, status: 'in_flight', createdAt: NOW });
    await db.transaction(async (trx) => {
      expect(await admitDailyFundedSpend(trx.executor, { holdMicrousd: 300, ceilingMicrousd: 1000, now: NOW })).toBe(true);
      expect(await admitDailyFundedSpend(trx.executor, { holdMicrousd: 301, ceilingMicrousd: 1000, now: NOW })).toBe(false);
    });
  });
});

describe.skipIf(!freeTierPostgresUrl)('capacity ceilings against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_capacity', 2); });
  afterAll(async () => { await scoped.close(); });

  it('starts no more than the running ceiling when many runtimes start at once across pools', async () => {
    const [first, second] = scoped.pools as [PlatformDB, PlatformDB];
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) ids.push(await addContainer(first, 100 + index, 'stopped'));
    const services = [first, second].map(db => createContainerLifecycleService({
      db, provider: idleProvider(), buildBootPayload: async () => '{}', now: () => NOW, maxRunning: 5,
    }));
    const results = await Promise.all(ids.map((id, index) => services[index % 2]!.ensureStarted(id)));
    expect(results.filter(result => result.state === 'starting')).toHaveLength(5);
    expect(results.filter(result => result.state === 'busy')).toHaveLength(7);
    const counted = await first.executor.selectFrom('user_machines').select(sql<number>`count(*)::int`.as('n'))
      .where('status', '=', 'starting').where('machine_id', 'in', ids).executeTakeFirstOrThrow();
    expect(counted.n).toBe(5);
  });

  it('never lets concurrent free admissions pass the daily funded spend ceiling', async () => {
    const [first, second] = scoped.pools as [PlatformDB, PlatformDB];
    const owners = [];
    for (let index = 0; index < 20; index += 1) owners.push(await seedFreeOwner(first, `race${index}`));
    const admitted = await Promise.all(owners.map((owner, index) => (index % 2 ? second : first).transaction(async (trx) => {
      if (!await admitDailyFundedSpend(trx.executor, { holdMicrousd: 100, ceilingMicrousd: 1000, now: NOW })) return false;
      await insertReservation(trx.executor, owner, { reserved: 100, status: 'reserved', createdAt: NOW });
      return true;
    })));
    expect(admitted.filter(Boolean)).toHaveLength(10);
    expect(await readDailyFundedSpend(first.executor, NOW)).toBe(1000);
  });
});
