import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { migrateUserMachines } from '../../packages/platform/src/database/migrations/user-machines.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

interface SubstrateRow {
  substrate: string;
  generation: number;
  substrate_ref: string | null;
  private_address: string | null;
  last_activity_at: Date | null;
  started_at: Date | null;
}

async function insertRaw(db: PlatformDB, values: {
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot?: string;
  substrate?: string;
  deletedAt?: string | null;
}): Promise<void> {
  const substrate = values.substrate ?? 'vps';
  await sql`
    INSERT INTO user_machines (machine_id, clerk_user_id, handle, runtime_slot, provisioned_at, substrate, deleted_at)
    VALUES (${values.machineId}, ${values.clerkUserId}, ${values.handle}, ${values.runtimeSlot ?? 'primary'},
      '2026-11-01T00:00:00.000Z', ${substrate}, ${values.deletedAt ?? null})
  `.execute(db.kysely);
}

describe('user_machines runtime substrate migration', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('backfills machines created before the substrate columns existed as generation-1 vps runtimes', async () => {
    await sql`DROP INDEX IF EXISTS idx_user_machines_clerk_active_container`.execute(db.kysely);
    await sql`
      ALTER TABLE user_machines
        DROP COLUMN substrate,
        DROP COLUMN generation,
        DROP COLUMN substrate_ref,
        DROP COLUMN private_address,
        DROP COLUMN last_activity_at,
        DROP COLUMN started_at
    `.execute(db.kysely);
    await sql`
      INSERT INTO user_machines (machine_id, clerk_user_id, handle, status, public_ipv4, provisioned_at)
      VALUES ('legacy-machine', 'user_legacy', 'legacy', 'running', '203.0.113.7', '2026-10-01T00:00:00.000Z')
    `.execute(db.kysely);

    await migrateUserMachines(db.kysely);
    await migrateUserMachines(db.kysely);

    const rows = await sql<SubstrateRow & { status: string; public_ipv4: string | null }>`
      SELECT substrate, generation, substrate_ref, private_address, last_activity_at, started_at, status, public_ipv4
      FROM user_machines WHERE machine_id = 'legacy-machine'
    `.execute(db.kysely);
    expect(rows.rows).toEqual([{
      substrate: 'vps',
      generation: 1,
      substrate_ref: null,
      private_address: null,
      last_activity_at: null,
      started_at: null,
      status: 'running',
      public_ipv4: '203.0.113.7',
    }]);
  });

  it('stores activity and session start as timestamps', async () => {
    await insertRaw(db, { machineId: 'm1', clerkUserId: 'user_a', handle: 'a' });
    await sql`
      UPDATE user_machines
      SET last_activity_at = '2026-11-02T10:00:00Z', started_at = '2026-11-02T09:00:00Z'
      WHERE machine_id = 'm1'
    `.execute(db.kysely);
    const rows = await sql<{ last_activity_at: Date; started_at: Date }>`
      SELECT last_activity_at, started_at FROM user_machines WHERE machine_id = 'm1'
    `.execute(db.kysely);
    expect(new Date(rows.rows[0]!.last_activity_at).toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(new Date(rows.rows[0]!.started_at).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('rejects substrates other than vps and container', async () => {
    await expect(insertRaw(db, { machineId: 'm1', clerkUserId: 'user_a', handle: 'a', substrate: 'lambda' }))
      .rejects.toThrow(/user_machines_substrate_check/);
    await insertRaw(db, { machineId: 'm2', clerkUserId: 'user_b', handle: 'b', substrate: 'container' });
  });

  it('rejects a generation below 1', async () => {
    await insertRaw(db, { machineId: 'm1', clerkUserId: 'user_a', handle: 'a' });
    await expect(sql`UPDATE user_machines SET generation = 0 WHERE machine_id = 'm1'`.execute(db.kysely))
      .rejects.toThrow(/user_machines_generation_check/);
  });

  it('allows at most one non-deleted container runtime per owner', async () => {
    await insertRaw(db, { machineId: 'c1', clerkUserId: 'user_a', handle: 'a', substrate: 'container' });
    await expect(insertRaw(db, {
      machineId: 'c2', clerkUserId: 'user_a', handle: 'a-two', runtimeSlot: 'second', substrate: 'container',
    })).rejects.toThrow(/idx_user_machines_clerk_active_container/);

    await insertRaw(db, {
      machineId: 'c-deleted', clerkUserId: 'user_a', handle: 'a-old', runtimeSlot: 'old',
      substrate: 'container', deletedAt: '2026-10-01T00:00:00.000Z',
    });
    await insertRaw(db, { machineId: 'v2', clerkUserId: 'user_a', handle: 'a-vps', runtimeSlot: 'vps-two' });
    await insertRaw(db, { machineId: 'c-other', clerkUserId: 'user_b', handle: 'b', substrate: 'container' });

    const counts = await sql<{ substrate: string; count: number }>`
      SELECT substrate, count(*)::int AS count FROM user_machines
      WHERE deleted_at IS NULL GROUP BY substrate ORDER BY substrate
    `.execute(db.kysely);
    expect(counts.rows).toEqual([{ substrate: 'container', count: 2 }, { substrate: 'vps', count: 1 }]);
  });
});
