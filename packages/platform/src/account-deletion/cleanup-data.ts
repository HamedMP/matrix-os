import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { AccountDeletionOwnershipError } from './types.js';
import { lockAccountDeletionOwner } from './repository.js';
import { ownerHandlesQuery } from './owner-handles.js';
import type { PlatformDB } from '../db.js';

export async function hasTable(db: PlatformDB, name: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`SELECT to_regclass(${name}) IS NOT NULL AS present`.execute(db.executor);
  return result.rows[0]?.present === true;
}
/** Shared data may live on this owner's runtime, even after a directory ownership transfer. */
export async function assertDeletionOwnershipSafe(db: PlatformDB, owner: string): Promise<void> {
  if (await hasTable(db, 'collaboration_directory')) {
    const shared = await sql`SELECT d.scope_id FROM collaboration_directory d
      WHERE (d.owner_id = ${owner} OR d.runtime_id IN
        (SELECT machine_id FROM user_machines WHERE clerk_user_id = ${owner}
          UNION SELECT 'vps:' || machine_id FROM user_machines WHERE clerk_user_id = ${owner}))
      AND (d.organization_id IS NOT NULL OR d.audience IS NOT NULL OR EXISTS
        (SELECT 1 FROM collaboration_user_index i WHERE i.scope_id = d.scope_id AND i.actor_id <> ${owner}
          AND i.status IN ('invited','accepted'))) LIMIT 1`.execute(db.executor);
    if (shared.rows.length) throw new AccountDeletionOwnershipError();
  }
  if (await hasTable(db, 'organization_memberships')) {
    const soleOwner = await sql`SELECT m.organization_id FROM organization_memberships m
      JOIN organizations o USING (organization_id)
      WHERE m.actor_id = ${owner} AND m.state = 'active' AND o.lifecycle = 'active'
      AND m.role IN ('org:owner','owner','org:admin') AND NOT EXISTS
        (SELECT 1 FROM organization_memberships other WHERE other.organization_id = m.organization_id
          AND other.actor_id <> ${owner} AND other.state = 'active' AND other.role IN ('org:owner','owner','org:admin'))
      LIMIT 1`.execute(db.executor);
    if (soleOwner.rows.length) throw new AccountDeletionOwnershipError();
  }
}

/** All platform writes share one transaction; accounting keeps only anonymous amounts and timestamps. */
export async function eraseOwnerPlatformData(db: PlatformDB, owner: string, ownerHash?: (owner: string) => string): Promise<void> {
  await db.transaction(async (trx) => {
    if (ownerHash) await lockAccountDeletionOwner(trx.executor,ownerHash(owner));
    await assertDeletionOwnershipSafe(trx, owner);
    // Serialize image deletion with admission; ambiguous provider charges retain
    // their reservation and evidence until an operator has reconciled them.
    for (const imageOwner of ['__image_global__', owner]) {
      await trx.executor.insertInto('image_owner_admissions').values({ owner_id: imageOwner }).onConflict(c => c.column('owner_id').doNothing()).execute();
      await trx.executor.selectFrom('image_owner_admissions').select('owner_id').where('owner_id', '=', imageOwner).forUpdate().executeTakeFirstOrThrow();
    }
    const unresolvedImages = await trx.executor.selectFrom('image_generation_operations').select('request_id')
      .where('owner_id', '=', owner).where('state', 'in', ['dispatching', 'uncertain']).limit(1).execute();
    if (unresolvedImages.length) throw new Error('accounting_reconciliation_required');
    const unresolved = await trx.executor.selectFrom('ai_funded_usage_reservations').select('reservation_id')
      .where('owner_id', '=', owner).where('status', 'not in', ['settled', 'released', 'expired']).limit(1).execute();
    if (unresolved.length) throw new Error('accounting_reconciliation_required');
    const liveRuntime=await trx.executor.selectFrom('user_machines').select('machine_id')
      .where('clerk_user_id','=',owner).where((eb)=>eb.or([eb('deleted_at','is',null),eb('status','!=','deleted')])).limit(1).execute();
    if(liveRuntime.length) throw new Error('runtime_cleanup_pending');
    // Keep owner inventories in PostgreSQL. Only bounded existence probes return
    // rows to the worker, including owners with many historical runtime slots.
    const ids = sql<string>`SELECT ${owner}::text AS id UNION
      SELECT id::text FROM users WHERE clerk_id = ${owner}`;
    const handles = sql<string>`(${ownerHandlesQuery(owner)})`;
    const machineIds = trx.executor.selectFrom('user_machines').select('machine_id').where('clerk_user_id','=',owner);
    const pending = await trx.executor.selectFrom('provider_deletion_queue').select('id')
      .where('machine_id','in',machineIds).where('completed_at','is',null).limit(1).execute();
    if (pending.length) throw new Error('runtime_cleanup_pending');
    await trx.executor.deleteFrom('billing_runtime_actions').where('machine_id','in',machineIds).execute();
    await trx.executor.deleteFrom('provisioning_jobs').where('machine_id','in',machineIds).execute();
    await trx.executor.deleteFrom('provider_deletion_queue').where('machine_id','in',machineIds).execute();
    await trx.executor.deleteFrom('golden_snapshot_create_intents').where('machine_id','in',machineIds).execute();
    await trx.executor.deleteFrom('golden_snapshot_leases').where('machine_id','in',machineIds).execute();
    // Maintain counts on other people's surviving content before deleting this owner's edges.
    await sql`UPDATE social_posts p SET likes_count = GREATEST(0, likes_count -
      (SELECT count(*)::integer FROM social_likes l WHERE l.post_id = p.id AND l.user_id IN (${ids}))),
      comments_count = GREATEST(0, comments_count -
      (SELECT count(*)::integer FROM social_comments c WHERE c.post_id = p.id AND c.author_id IN (${ids})))
      WHERE p.author_id NOT IN (${ids}) AND (EXISTS
        (SELECT 1 FROM social_likes l WHERE l.post_id=p.id AND l.user_id IN (${ids})) OR EXISTS
        (SELECT 1 FROM social_comments c WHERE c.post_id=p.id AND c.author_id IN (${ids})))`.execute(trx.executor);
    await sql`DELETE FROM social_likes WHERE user_id IN (${ids}) OR post_id IN
      (SELECT id FROM social_posts WHERE author_id IN (${ids}))`.execute(trx.executor);
    await sql`DELETE FROM social_comments WHERE author_id IN (${ids}) OR post_id IN
      (SELECT id FROM social_posts WHERE author_id IN (${ids}))`.execute(trx.executor);
    await trx.executor.deleteFrom('social_posts').where('author_id','in',sql<string>`(${ids})`).execute();
    await sql`DELETE FROM social_follows WHERE follower_id IN (${ids}) OR following_id IN (${ids})`.execute(trx.executor);
    await sql`DELETE FROM app_ratings WHERE user_id IN (${ids}) OR app_id IN
      (SELECT id FROM apps_registry WHERE author_id IN (${ids}) AND is_public = false)`.execute(trx.executor);
    await sql`DELETE FROM app_installs WHERE user_id IN (${ids}) OR app_id IN
      (SELECT id FROM apps_registry WHERE author_id IN (${ids}) AND is_public = false)`.execute(trx.executor);
    await sql`DELETE FROM apps_registry WHERE author_id IN (${ids}) AND is_public = false`.execute(trx.executor);
    const anonymous = `deleted:${createHash('sha256').update(owner).digest('hex')}`;
    if(await hasTable(trx,'ats_applications')) {
      await sql`UPDATE ats_applications SET owner_id=NULL WHERE owner_id=${owner}`.execute(trx.executor);
      await sql`UPDATE ats_application_events SET actor_id=NULL WHERE actor_id=${owner}`.execute(trx.executor);
      await sql`UPDATE ats_notes SET author_id=${anonymous} WHERE author_id=${owner}`.execute(trx.executor);
      await sql`UPDATE ats_scorecards SET interviewer_id=${anonymous} WHERE interviewer_id=${owner}`.execute(trx.executor);
      await sql`UPDATE ats_tasks SET assignee_id=NULL WHERE assignee_id=${owner}`.execute(trx.executor);
      await sql`UPDATE ats_interviews SET interviewer_ids = COALESCE((SELECT jsonb_agg(value)
        FROM jsonb_array_elements_text(interviewer_ids::jsonb) entries(value) WHERE value<>${owner}),'[]'::jsonb)::text
        WHERE interviewer_ids::jsonb @> jsonb_build_array(${owner}::text)`.execute(trx.executor);
    }
    await sql`UPDATE apps_registry SET author_id = ${anonymous}, source_url = NULL
      WHERE author_id IN (${ids}) AND is_public = true`.execute(trx.executor);
    if (await hasTable(trx,'collaboration_directory')) {
      await sql`DELETE FROM collaboration_connection_tickets WHERE actor_id = ${owner}`.execute(trx.executor);
      await sql`DELETE FROM collaboration_user_index WHERE actor_id = ${owner}`.execute(trx.executor);
      await sql`DELETE FROM collaboration_directory WHERE owner_id = ${owner}`.execute(trx.executor);
    }
    if (await hasTable(trx,'organization_memberships')) {
      await sql`DELETE FROM organization_memberships WHERE actor_id = ${owner}`.execute(trx.executor);
      await sql`DELETE FROM organization_revocation_outbox WHERE actor_id = ${owner}`.execute(trx.executor);
      await sql`UPDATE collaboration_denials SET actor_id = NULL WHERE actor_id = ${owner}
        AND (organization_id IS NOT NULL OR scope_id IS NOT NULL)`.execute(trx.executor);
      await sql`DELETE FROM collaboration_denial_runtimes WHERE denial_id IN
        (SELECT denial_id FROM collaboration_denials WHERE actor_id = ${owner})`.execute(trx.executor);
      await sql`DELETE FROM collaboration_denials WHERE actor_id = ${owner}`.execute(trx.executor);
    }
    await sql`DELETE FROM ai_funded_reservation_promotional_allocations WHERE reservation_id IN
      (SELECT reservation_id FROM ai_funded_usage_reservations WHERE owner_id = ${owner}) OR grant_entry_id IN
      (SELECT entry_id FROM ai_funded_credit_ledger WHERE owner_id = ${owner})`.execute(trx.executor);
    const ledger = await trx.executor.selectFrom('ai_funded_credit_ledger').select('entry_id').where('owner_id','=',owner).limit(1).execute();
    if (ledger.length) {
      if (!ownerHash) throw new Error('Accounting erasure configuration unavailable');
      const summary = await sql`UPDATE account_deletion_jobs SET accounting_summary =
        (SELECT jsonb_object_agg(kind, totals) FROM
          (SELECT kind, jsonb_build_object('entryCount', count(*), 'amountMicrousd', sum(amount_microusd)) AS totals
            FROM ai_funded_credit_ledger WHERE owner_id = ${owner} GROUP BY kind) entries)
        WHERE owner_hash = ${ownerHash(owner)} RETURNING owner_hash`.execute(trx.executor);
      if (!summary.rows.length) throw new Error('Accounting erasure tombstone unavailable');
    }
    await trx.executor.deleteFrom('ai_funded_credit_ledger').where('owner_id','=',owner).execute();
    for (const table of ['ai_runtime_credentials', 'ai_funded_priority_claims', 'ai_funded_runtime_policies',
      'ai_funded_promotional_grant_balances', 'ai_funded_runtime_balances', 'ai_funded_credit_restrictions',
      'image_generation_operations', 'image_monthly_allowances', 'image_owner_admissions',
      'speech_operations', 'speech_runtime_allowances', 'ai_credit_checkout_claims', 'ai_funded_usage_reservations'] as const) {
      await trx.executor.deleteFrom(table).where('owner_id','=',owner).execute();
    }
    for (const table of ['billing_customers','billing_subscriptions','billing_entitlements','billing_entitlement_overrides',
      'prebilling_provisioning_intents','billing_checkout_attempts','billing_trial_accounts','onboarding_first_run',
      'onboarding_journey_events','device_codes'] as const) {
      await trx.executor.deleteFrom(table).where('clerk_user_id','=',owner).execute();
    }
    await sql`UPDATE user_machines SET access_clerk_user_ids = array_remove(access_clerk_user_ids, ${owner})
      WHERE ${owner} = ANY(access_clerk_user_ids)`.execute(trx.executor);
    // Handle subqueries must run before deleting their source runtime records.
    await trx.executor.deleteFrom('matrix_users').where('handle','in',handles).execute();
    await trx.executor.updateTable('port_assignments').set({ handle: null }).where('handle','in',handles).execute();
    await trx.executor.deleteFrom('user_machines').where('clerk_user_id','=',owner).execute();
    await trx.executor.deleteFrom('containers').where('clerk_user_id','=',owner).execute();
    // Gateway integration tables reference users with ON DELETE CASCADE, erasing encrypted credentials too.
    await trx.executor.deleteFrom('users').where('clerk_id','=',owner).execute();
  });
}
