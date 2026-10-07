import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDatabase } from '../../packages/platform/src/db.js';
import { migrateAccountDeletion } from '../../packages/platform/src/database/migrations/account-deletion.js';
import { AccountDeletionRepository, hashAccountDeletionOwner, lockAccountDeletionOwner } from '../../packages/platform/src/account-deletion/repository.js';
import { createAccountDeletionService } from '../../packages/platform/src/account-deletion/service.js';
import { ACCOUNT_DELETION_GRACE_MS, type AccountDeletionAdapters } from '../../packages/platform/src/account-deletion/types.js';
const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const secret = 'account-deletion-postgres-test-secret-32-bytes';
const owner = 'user_postgresdeletion000000001';
describe.skipIf(!connectionString)('account deletion on real PostgreSQL', () => {
  let admin: Kysely<Record<string, never>>;
  let db: Kysely<PlatformDatabase>;
  let schema: string;
  let clock: Date;
  const now = () => clock;
  beforeEach(async () => {
    clock = new Date('2026-10-05T12:00:00.000Z');
    schema = `account_deletion_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 6, options: `-c search_path=${schema},public` }) }) });
    await migrateAccountDeletion(db);
  });
  afterEach(async () => { await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); });
  function adapters(): AccountDeletionAdapters {
    return { prepare: vi.fn(async (clerkUserId) => ({ clerkUserId, appleTokens: [] })),
      billing: vi.fn(async () => {}), vps: vi.fn(async () => {}), integrations: vi.fn(async () => {}),
      apple: vi.fn(async () => {}), storage: vi.fn(async () => {}), data: vi.fn(async () => {}), clerk: vi.fn(async () => {}) };
  }
  it('serializes repeated scheduling and competing workers without repeating successful steps', async () => {
    const cleanup = adapters();
    const a = createAccountDeletionService({ db, secret, now, adapters: cleanup });
    const b = createAccountDeletionService({ db, secret, now, adapters: cleanup });
    const statuses = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).schedule(owner)));
    expect(statuses.every((status) => status.status === 'scheduled')).toBe(true);
    expect(cleanup.billing).toHaveBeenCalledOnce();
    expect(await db.selectFrom('account_deletion_jobs').selectAll().execute()).toHaveLength(1);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await Promise.all([a.reconcile(), b.reconcile()]);
    expect(cleanup.vps).toHaveBeenCalledOnce();
    expect(cleanup.clerk).toHaveBeenCalledOnce();
    expect(await a.get(owner)).toMatchObject({ status: 'completed' });
  });
  it('waits for native Apple credential capture to commit before preparing deletion', async () => {
    let releaseCapture!: () => void;
    let signalLocked!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let captured = false;
    const capture = db.transaction().execute(async (trx) => {
      await lockAccountDeletionOwner(trx, hashAccountDeletionOwner(owner, secret));
      signalLocked();
      await gate;
      captured = true;
    });
    await locked;
    const cleanup = adapters();
    cleanup.prepare = vi.fn(async (clerkUserId) => ({ clerkUserId,
      appleTokens: captured ? [{ clientId: 'com.matrixos.mobile', token: 'new-native-refresh-token', tokenType: 'refresh_token' as const }] : [] }));
    const service = createAccountDeletionService({ db, secret, now, adapters: cleanup });
    const scheduling = service.schedule(owner);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const preparedBeforeCaptureCommitted = vi.mocked(cleanup.prepare).mock.calls.length > 0;
    releaseCapture();
    await capture;
    await scheduling;
    expect(preparedBeforeCaptureCommitted).toBe(false);
    const repo = new AccountDeletionRepository(db, { secret, now });
    expect(repo.decrypt((await repo.get(owner))!).appleTokens).toEqual([
      { clientId: 'com.matrixos.mobile', token: 'new-native-refresh-token', tokenType: 'refresh_token' },
    ]);
    await service.schedule(owner);
    expect(cleanup.prepare).toHaveBeenCalledOnce();
  });
  it('prevents both cancellation and deletion from winning the same transition', async () => {
    const repo = new AccountDeletionRepository(db, { secret, now });
    await repo.accept({ clerkUserId: owner, appleTokens: [] }, false);
    const billing = await repo.claim(owner, 30_000);
    await repo.checkpoint(billing!, 1, 30_000);
    await repo.release(billing!, false);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS - 1);
    const [cancelled, claim] = await Promise.allSettled([repo.cancel(owner), repo.claim(owner, 30_000)]);
    expect(cancelled.status).toBe('fulfilled');
    expect(claim).toMatchObject({ status: 'fulfilled', value: undefined });
    clock = new Date(clock.getTime() + 2);
    expect(await repo.claim(owner, 30_000)).toBeUndefined();
  });
  it('reclaims crashed leases and rejects stale checkpoint writes', async () => {
    const repo = new AccountDeletionRepository(db, { secret, now });
    await repo.accept({ clerkUserId: owner, appleTokens: [] }, true);
    const old = await repo.claim(owner, 1000);
    clock = new Date(clock.getTime() + 1001);
    const current = await repo.claim(owner, 1000);
    expect(current?.lease_token).not.toEqual(old?.lease_token);
    expect(await repo.checkpoint(old!, 1, 1000)).toBe(false);
    expect(await repo.checkpoint(current!, 1, 1000)).toBe(true);
  });
});
