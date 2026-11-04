import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { AccountDeletionOwnershipError } from './types.js';

/** Called inside account erasure's transaction, after runtime/provider-queue guards. */
export async function eraseRetiredPreviewPairBindings(trx: PlatformDB, owner: string): Promise<void> {
  // Keep inventories and probes bounded in PostgreSQL. A binding must agree with
  // both machine and job ownership before erasure may discard its cleanup proof.
  const bindings = sql`SELECT member.* FROM preview_pair_members member
    JOIN provisioning_jobs job ON job.job_id = member.job_id
    JOIN user_machines machine ON machine.machine_id = member.machine_id
    WHERE machine.clerk_user_id = ${owner} OR job.machine_id IN
      (SELECT machine_id FROM user_machines WHERE clerk_user_id = ${owner})`;
  const foreign = await sql`SELECT 1 FROM (${bindings}) member
    JOIN provisioning_jobs job ON job.job_id = member.job_id
    JOIN user_machines machine ON machine.machine_id = member.machine_id
    WHERE member.actor_id <> ${owner} OR machine.clerk_user_id <> ${owner}
      OR job.machine_id <> member.machine_id LIMIT 1`.execute(trx.executor);
  if (foreign.rows.length) throw new AccountDeletionOwnershipError();
  const pending = await sql`SELECT 1 FROM (${bindings}) member
    WHERE member.retired_at IS NULL OR member.provider_absent_at IS NULL LIMIT 1`.execute(trx.executor);
  if (pending.rows.length) throw new Error('runtime_cleanup_pending');
  await sql`DELETE FROM preview_pair_members WHERE actor_id = ${owner}
    AND machine_id IN (SELECT machine_id FROM user_machines WHERE clerk_user_id = ${owner})
    AND retired_at IS NOT NULL AND provider_absent_at IS NOT NULL`.execute(trx.executor);
}
