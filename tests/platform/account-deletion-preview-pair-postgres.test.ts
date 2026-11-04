import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { createPreviewPairPostgresFixture } from './preview-pair-postgres-support.js';

const now = '2026-11-04T12:00:00.000Z';
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)('account erasure with preview-pair journals on PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  beforeAll(async () => { fixture = await createPreviewPairPostgresFixture(); }, 30_000);
  afterAll(async () => { await fixture?.destroy(); });

  async function seed(id: string, options: { retired?: boolean; absent?: boolean; actor?: string; live?: boolean } = {}) {
    const db = fixture.db.executor;
    const owner = `user_${id}`;
    await sql`INSERT INTO preview_pairs(pair_id,repository,pr,requester_id,source_sha,state,created_at,expires_at,stopped_at)
      VALUES (${id},'HamedMP/matrix-os',3028,${owner},${'a'.repeat(40)},'stopped',${now},'2026-11-05',${now})`.execute(db);
    await sql`INSERT INTO preview_pair_generations(pair_id,generation,source_sha,created_at,retired_at)
      VALUES (${id},1,${'a'.repeat(40)},${now},${now})`.execute(db);
    for (const role of ['owner', 'member']) {
      const machine = `${id}_${role}`;
      const actor = role === 'owner' ? (options.actor ?? owner) : `peer_${id}`;
      const live = role === 'owner' && options.live;
      await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,runtime_slot,status,deleted_at,provisioned_at)
        VALUES (${machine},${role === 'owner' ? owner : actor},${machine},${machine},${live ? 'running' : 'deleted'},${live ? null : now},${now})`.execute(db);
      await sql`INSERT INTO provisioning_jobs(job_id,machine_id,status,available_at,created_at,updated_at,completed_at)
        VALUES (${machine},${machine},'failed',${now},${now},${now},${now})`.execute(db);
      await sql`INSERT INTO preview_pair_members(pair_id,generation,role,actor_id,machine_id,job_id,handle,retired_at,provider_absent_at)
        VALUES (${id},1,${role},${actor},${machine},${machine},${machine},
          ${options.retired === false ? null : now},${options.absent === false || options.retired === false ? null : now})`.execute(db);
    }
    return owner;
  }

  it('erases only confirmed-absent owner bindings before jobs and machines, preserving peers and the pair audit', async () => {
    const owner = await seed('erased');
    await expect(eraseOwnerPlatformData(fixture.db, owner)).resolves.toBeUndefined();
    await expect(eraseOwnerPlatformData(fixture.db, owner)).resolves.toBeUndefined();
    const members = await sql<{ role: string }>`SELECT role FROM preview_pair_members WHERE pair_id='erased'`.execute(fixture.db.executor);
    expect(members.rows).toEqual([{ role: 'member' }]);
    for (const table of ['user_machines', 'provisioning_jobs'] as const) {
      const rows = await fixture.db.executor.selectFrom(table).select('machine_id').where('machine_id', 'like', 'erased_%').execute();
      expect(rows).toEqual([{ machine_id: 'erased_member' }]);
    }
    expect((await sql`SELECT pair_id FROM preview_pairs WHERE pair_id='erased'`.execute(fixture.db.executor)).rows).toHaveLength(1);
  });

  it.each([
    ['unconfirmed', { absent: false }, 'runtime_cleanup_pending'],
    ['unretired', { retired: false }, 'runtime_cleanup_pending'],
    ['live', { live: true }, 'runtime_cleanup_pending'],
    ['mismatch', { actor: 'user_foreign' }, 'ownership_transfer_required'],
  ] as const)('retains journals and rolls back erasure for %s resources', async (id, options, error) => {
    const owner = await seed(id, options);
    await expect(eraseOwnerPlatformData(fixture.db, owner)).rejects.toThrow(error);
    expect((await sql`SELECT role FROM preview_pair_members WHERE pair_id=${id}`.execute(fixture.db.executor)).rows).toHaveLength(2);
    expect(await fixture.db.executor.selectFrom('user_machines').select('machine_id').where('machine_id', '=', `${id}_owner`).execute()).toHaveLength(1);
    expect(await fixture.db.executor.selectFrom('provisioning_jobs').select('job_id').where('job_id', '=', `${id}_owner`).execute()).toHaveLength(1);
  });
});
