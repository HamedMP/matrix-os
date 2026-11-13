import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createStorageQuota, DEFAULT_STORAGE_QUOTA_LIMITS } from '../../packages/platform/src/free-tier/storage-quota.js';
import { createStorageQuotaSweeper } from '../../packages/platform/src/free-tier/storage-quota-sweep.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const T0 = new Date('2026-11-13T12:00:00.000Z');
const MINUTE = 60_000;

function store() {
  const sizes = new Map<string, number>();
  const headObject = vi.fn(async (key: string) => sizes.has(key) ? { exists: true, contentLength: sizes.get(key) } : { exists: false });
  return { sizes, headObject };
}

async function usage(db: PlatformDB, owner: string) {
  const row = await db.executor.selectFrom('runtime_storage_usage').select(['object_bytes', 'object_count'])
    .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
  return { bytes: Number(row.object_bytes), count: row.object_count };
}

describe('storage quota sweep', () => {
  let db: PlatformDB;
  const clock = { now: T0 };
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock.now = T0;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  function quotaWith(objects: ReturnType<typeof store>) {
    return createStorageQuota({ db, limits: DEFAULT_STORAGE_QUOTA_LIMITS, headObject: objects.headObject, now: () => clock.now });
  }

  it('settles expired pending writes without waiting for a refused write, leaving live and confirmed ones alone', async () => {
    const objects = store();
    const quota = quotaWith(objects);
    await quota.authorize('user_a', { key: 'a/landed', bytes: 100, countsAsFile: true, pendingMs: MINUTE });
    await quota.authorize('user_a', { key: 'a/missing', bytes: 200, countsAsFile: true, pendingMs: MINUTE });
    await quota.authorize('user_b', { key: 'b/fresh', bytes: 300, countsAsFile: true, pendingMs: 60 * MINUTE });
    await quota.authorize('user_b', { key: 'b/done', bytes: 400, countsAsFile: true, pendingMs: null });
    objects.sizes.set('a/landed', 90);
    clock.now = new Date(T0.getTime() + 2 * MINUTE);

    const sweeper = createStorageQuotaSweeper({ db, quota, now: () => clock.now });
    expect(await sweeper.sweepOnce()).toEqual({ ran: true, owners: 1, settled: 2 });
    expect(await usage(db, 'user_a')).toEqual({ bytes: 90, count: 1 });
    expect(await usage(db, 'user_b')).toEqual({ bytes: 700, count: 2 });
    expect(objects.headObject.mock.calls.map(([key]) => key).sort()).toEqual(['a/landed', 'a/missing']);
    expect(await sweeper.sweepOnce()).toEqual({ ran: true, owners: 0, settled: 0 });
  });

  it('reconciles at most a batch of owners per run, oldest expiry first', async () => {
    const objects = store();
    const quota = quotaWith(objects);
    for (const [index, owner] of ['user_c', 'user_a', 'user_b'].entries()) {
      clock.now = new Date(T0.getTime() + index * MINUTE);
      await quota.authorize(owner, { key: `${owner}/k`, bytes: 10, countsAsFile: true, pendingMs: MINUTE });
    }
    clock.now = new Date(T0.getTime() + 10 * MINUTE);
    const reconciled: string[] = [];
    const sweeper = createStorageQuotaSweeper({
      db, quota: { reconcile: async (owner) => { reconciled.push(owner); return quota.reconcile(owner); } },
      ownerBatch: 2, now: () => clock.now,
    });
    expect(await sweeper.sweepOnce()).toEqual({ ran: true, owners: 2, settled: 2 });
    expect(reconciled).toEqual(['user_c', 'user_a']);
  });

  it('stops starting owners once its time budget is spent, and one failing owner does not stop the rest', async () => {
    const objects = store();
    const quota = quotaWith(objects);
    for (const owner of ['user_a', 'user_b', 'user_c']) {
      await quota.authorize(owner, { key: `${owner}/k`, bytes: 10, countsAsFile: true, pendingMs: MINUTE });
    }
    clock.now = new Date(T0.getTime() + 10 * MINUTE);
    const errors: string[] = [];
    let ticks = 0;
    const sweeper = createStorageQuotaSweeper({
      db,
      quota: {
        async reconcile(owner) {
          ticks += 1;
          if (owner === 'user_a') throw new TypeError('store down');
          return 1;
        },
      },
      budgetMs: 1_500,
      monotonicNow: () => ticks * 1_000,
      now: () => clock.now,
      logError: (message) => { errors.push(message); },
    });
    expect(await sweeper.sweepOnce()).toEqual({ ran: true, owners: 2, settled: 1 });
    expect(errors).toEqual(['[storage-quota] sweep reconcile failed']);
  });

  it('starts one timer and clears it on shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const sweeper = createStorageQuotaSweeper({ db, quota: { reconcile: async () => 0 } });
      sweeper.start();
      sweeper.start();
      expect(vi.getTimerCount()).toBe(1);
      await sweeper.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!freeTierPostgresUrl)('storage quota sweep across platform instances on real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('quota_sweep', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('runs one sweep at a time', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const objects = store();
    const quota = createStorageQuota({ db: a, limits: DEFAULT_STORAGE_QUOTA_LIMITS, headObject: objects.headObject, now: () => T0 });
    await quota.authorize('user_race', { key: 'race/k', bytes: 10, countsAsFile: true, pendingMs: MINUTE });
    const later = () => new Date(T0.getTime() + 10 * MINUTE);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const slow = createStorageQuotaSweeper({ db: a, quota: { async reconcile() { entered(); await gate; return 0; } }, now: later });
    const other = createStorageQuotaSweeper({ db: b, quota: { reconcile: async () => 0 }, now: later });
    try {
      const first = slow.sweepOnce();
      await started;
      expect(await other.sweepOnce()).toEqual({ ran: false, owners: 0, settled: 0 });
      release();
      expect((await first).ran).toBe(true);
      expect((await other.sweepOnce()).ran).toBe(true);
    } finally {
      release();
      await Promise.all([slow.shutdown(), other.shutdown()]);
    }
  });
});
