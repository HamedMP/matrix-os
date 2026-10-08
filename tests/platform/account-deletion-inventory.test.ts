import { sql, type KyselyPlugin } from 'kysely';
import { describe, expect, it } from 'vitest';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { wrapPlatformDb } from '../../packages/platform/src/database/transaction-scope.js';
import { createTestPlatformDb } from './platform-db-test-helper.js';

describe('owner cleanup without JavaScript runtime inventories', () => {
  it('erases every historical runtime handle and queue row while preserving neighbors and social counts', async () => {
    const { db: base } = await createTestPlatformDb();
    let observing = false;
    let largestResult = 0;
    const observer: KyselyPlugin = {
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (observing) largestResult = Math.max(largestResult, result.rows.length);
        return result;
      },
    };
    const root = base.kysely.withPlugin(observer);
    const db = wrapPlatformDb(root, root, base.ready, () => base.destroy());
    const owner = 'user_inventory';
    const other = 'user_inventory_neighbor';
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const otherId = '22222222-2222-4222-8222-222222222222';
    try {
      // Identity and legacy-container owner keys remain UNIQUE. Large inventory
      // comes from historical runtime slots, each with a distinct machine/handle.
      await sql`INSERT INTO users(id,clerk_id,handle,display_name,email,container_id) VALUES
        (${ownerId},${owner},'owner_identity','Owner','owner@example.test','owner-container'),
        (${otherId},${other},'neighbor_identity','Neighbor','neighbor@example.test','neighbor-container')`.execute(db.executor);
      await sql`INSERT INTO containers(handle,clerk_user_id,port,shell_port,status,created_at,last_active) VALUES
        ('owner_legacy',${owner},20000,21000,'deleted','2026-10-01','2026-10-01'),
        ('neighbor_legacy',${other},20001,21001,'running','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,runtime_slot,status,deleted_at,provisioned_at)
        SELECT 'owner_machine_' || n,${owner},'owner_runtime_' || n,'historical-' || n,
          'deleted','2026-10-01','2026-10-01' FROM generate_series(1,1005) n`.execute(db.executor);
      await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,status,provisioned_at,access_clerk_user_ids)
        VALUES ('neighbor_machine',${other},'neighbor_runtime','running','2026-10-01',ARRAY[${owner},${other}])`.execute(db.executor);
      await sql`INSERT INTO matrix_users(handle,human_matrix_id,ai_matrix_id,human_access_token,ai_access_token,created_at)
        SELECT handle,'@' || handle || ':example.test','@' || handle || '-ai:example.test',
          'human-' || handle,'ai-' || handle,'2026-10-01' FROM
          (SELECT handle FROM users UNION SELECT handle FROM containers UNION SELECT handle FROM user_machines) handles`.execute(db.executor);
      await sql`INSERT INTO port_assignments(port,handle)
        SELECT 30000 + row_number() OVER (ORDER BY handle)::integer,handle FROM matrix_users`.execute(db.executor);
      await sql`INSERT INTO provisioning_jobs(job_id,machine_id,status,available_at,created_at,updated_at,completed_at)
        SELECT 'job_' || machine_id,machine_id,'failed','2026-10-01','2026-10-01','2026-10-01','2026-10-01'
        FROM user_machines`.execute(db.executor);
      await sql`INSERT INTO billing_runtime_actions(id,machine_id,stripe_subscription_id,action,reason,status,execute_after,created_at,updated_at)
        SELECT 'billing_' || machine_id,machine_id,'sub_fixture','suspend','fixture','completed',
          '2026-10-01','2026-10-01','2026-10-01' FROM user_machines`.execute(db.executor);
      await sql`INSERT INTO provider_deletion_queue(id,provider_server_id,reason,machine_id,next_attempt_at,created_at,completed_at)
        SELECT 'provider_' || machine_id,row_number() OVER (ORDER BY machine_id)::integer,'fixture',machine_id,
          '2026-10-01','2026-10-01','2026-10-01' FROM user_machines`.execute(db.executor);
      await sql`INSERT INTO social_posts(id,author_id,content,type,likes_count,comments_count,created_at) VALUES
        ('surviving',${otherId},'neighbor content','text',3,3,'2026-10-01'),
        ('owner_clerk_post',${owner},'removed','text',0,0,'2026-10-01'),
        ('owner_uuid_post',${ownerId},'removed','text',0,0,'2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO social_likes(post_id,user_id,created_at) VALUES
        ('surviving',${owner},'2026-10-01'),('surviving',${ownerId},'2026-10-01'),('surviving',${otherId},'2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO social_comments(id,post_id,author_id,content,created_at) VALUES
        ('owner_clerk_comment','surviving',${owner},'removed','2026-10-01'),
        ('owner_uuid_comment','surviving',${ownerId},'removed','2026-10-01'),
        ('neighbor_comment','surviving',${otherId},'retained','2026-10-01')`.execute(db.executor);

      observing = true;
      try { await eraseOwnerPlatformData(db, owner); }
      finally { observing = false; }

      // Only coarse existence probes may cross the database/JavaScript boundary.
      // No runtime, identity or handle inventory is materialized during erasure.
      expect(largestResult).toBeLessThanOrEqual(1);
      expect(await db.executor.selectFrom('matrix_users').select('handle').orderBy('handle').execute())
        .toEqual([{ handle: 'neighbor_identity' }, { handle: 'neighbor_legacy' }, { handle: 'neighbor_runtime' }]);
      expect((await sql<{ count: number }>`SELECT count(*)::integer AS count FROM port_assignments WHERE handle IS NULL`
        .execute(db.executor)).rows[0]!.count).toBe(1007);
      expect((await sql<{ count: number }>`SELECT count(*)::integer AS count FROM port_assignments WHERE handle IS NOT NULL`
        .execute(db.executor)).rows[0]!.count).toBe(3);
      expect(await db.executor.selectFrom('user_machines').select(['machine_id', 'access_clerk_user_ids']).execute())
        .toEqual([{ machine_id: 'neighbor_machine', access_clerk_user_ids: [other] }]);
      expect(await db.executor.selectFrom('users').select('clerk_id').execute()).toEqual([{ clerk_id: other }]);
      expect(await db.executor.selectFrom('containers').select('clerk_user_id').execute()).toEqual([{ clerk_user_id: other }]);
      for (const table of ['provisioning_jobs', 'billing_runtime_actions', 'provider_deletion_queue'] as const) {
        expect(await db.executor.selectFrom(table).select('machine_id').execute()).toEqual([{ machine_id: 'neighbor_machine' }]);
      }
      expect(await db.executor.selectFrom('social_posts').select(['id', 'likes_count', 'comments_count']).execute())
        .toEqual([{ id: 'surviving', likes_count: 1, comments_count: 1 }]);
      expect(await db.executor.selectFrom('social_likes').select('user_id').execute()).toEqual([{ user_id: otherId }]);
      expect(await db.executor.selectFrom('social_comments').select('author_id').execute()).toEqual([{ author_id: otherId }]);
      await expect(eraseOwnerPlatformData(db, owner)).resolves.toBeUndefined();
    } finally { await db.destroy(); }
  }, 30_000);
});
