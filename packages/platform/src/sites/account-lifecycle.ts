import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import type { AccountDeletionObjectStore } from '../account-deletion/storage.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import { SiteError } from './types.js';
import { siteRecipientKey } from './email-keys.js';
import { appendSiteInvitationAuditEvent } from './invitation-audit.js';

const RecipientEvent = z.object({
    userId: z.string().regex(/^user_[A-Za-z0-9_-]{1,150}$/),
    state: z.enum(['active', 'inactive', 'deleted']),
    eventId: z.string().min(1).max(255),
    eventAt: z.date(),
    secret: z.string().min(32),
}).strict();

/** Signed Clerk events share recipient admission, so acceptance cannot overtake an inactive event. */
export async function recordSiteRecipientLifecycle(db: PlatformDB, input: unknown): Promise<void> {
    const event = RecipientEvent.parse(input);
    const env = { ACCOUNT_DELETION_SECRET: event.secret };
    const recipientKey = siteRecipientKey(event.userId, event.secret);
    await db.transaction(async trx => {
        await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
        await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
        await withAccountDeletionOwnerLock(trx, event.userId, async admitted => {
            const now = new Date();
            const projected = await admitted.executor.insertInto('public_site_recipient_lifecycle').values({
                recipient_key: recipientKey, state: event.state, last_event_id: event.eventId,
                last_event_at: event.eventAt, updated_at: now,
            }).onConflict(oc => oc.column('recipient_key').doUpdateSet({
                state: event.state, last_event_id: event.eventId, last_event_at: event.eventAt, updated_at: now,
            }).where(sql<boolean>`public_site_recipient_lifecycle.state <> 'deleted' AND
                (${event.state} = 'deleted' OR public_site_recipient_lifecycle.last_event_at < ${event.eventAt}
                 OR (public_site_recipient_lifecycle.last_event_at = ${event.eventAt}
                     AND public_site_recipient_lifecycle.state = 'active' AND ${event.state} = 'inactive'))`))
                .returning('state').executeTakeFirst();
            if (!projected || projected.state === 'active') return;
            const reason = projected.state === 'deleted' ? 'recipient_deleted' : 'recipient_inactive';
            let cursor = '';
            for (;;) {
                const sites = await admitted.executor.selectFrom('public_site_viewer_grants')
                    .select('site_id').distinct().where('clerk_user_id', '=', event.userId)
                    .where('site_id', '>', cursor).orderBy('site_id').limit(100).execute();
                if (!sites.length) break;
                for (const { site_id: siteId } of sites) {
                    await admitted.executor.selectFrom('public_sites').select('id')
                        .where('id', '=', siteId).forUpdate().executeTakeFirst();
                    const grantRefs = await admitted.executor.selectFrom('public_site_viewer_grants')
                        .select(['id', 'invitation_id']).where('site_id', '=', siteId)
                        .where('clerk_user_id', '=', event.userId).where('revoked_at', 'is', null)
                        .orderBy('invitation_id').execute();
                    for (const invitationId of [...new Set(grantRefs.map(grant => grant.invitation_id))]) {
                        await admitted.executor.selectFrom('public_site_email_invitations')
                            .select('id').where('id', '=', invitationId).forUpdate().executeTakeFirst();
                    }
                    const grants = grantRefs.length ? await admitted.executor.selectFrom('public_site_viewer_grants')
                        .select(['id', 'invitation_id']).where('id', 'in', grantRefs.map(grant => grant.id))
                        .where('revoked_at', 'is', null).orderBy('invitation_id').forUpdate().execute() : [];
                    for (const grant of grants) {
                        await admitted.executor.updateTable('public_site_viewer_sessions').set({ revoked_at: now })
                            .where('grant_id', '=', grant.id).where('revoked_at', 'is', null).execute();
                        await admitted.executor.updateTable('public_site_viewer_grants')
                            .set({ revoked_at: now, revocation_reason: reason })
                            .where('id', '=', grant.id).where('revoked_at', 'is', null).execute();
                        await admitted.executor.updateTable('public_site_email_invitations').set({
                            state: 'revoked', revoked_at: now, state_reason: reason, updated_at: now,
                            revision: sql`revision + 1`,
                        }).where('id', '=', grant.invitation_id).where('state', '=', 'accepted')
                            .where('accepted_clerk_user_id', '=', event.userId).execute();
                        await admitted.executor.updateTable('public_site_invitation_deliveries')
                            .set({ state: 'cancelled', lease_token: null, lease_until: null, updated_at: now })
                            .where('invitation_id', '=', grant.invitation_id)
                            .where('state', 'in', ['queued', 'failed', 'ambiguous']).execute();
                        await appendSiteInvitationAuditEvent(admitted, { siteId, invitationId: grant.invitation_id,
                            type: 'grant_revoked', actorKind: 'system', actorReference: null,
                            details: { reason } });
                    }
                }
                if (sites.length < 100) break;
                cursor = sites[sites.length - 1]!.site_id;
            }
            if (projected.state === 'deleted') {
                const pseudonym = `deleted:${recipientKey}`;
                await admitted.executor.updateTable('public_site_viewer_grants')
                    .set({ clerk_user_id: pseudonym }).where('clerk_user_id', '=', event.userId).execute();
                await admitted.executor.updateTable('public_site_email_invitations')
                    .set({ accepted_clerk_user_id: pseudonym }).where('accepted_clerk_user_id', '=', event.userId).execute();
                await admitted.executor.updateTable('public_site_access_audit_events')
                    .set({ actor_reference: null }).where('actor_reference', '=', event.userId).execute();
            }
        }, env);
    });
}
export function siteOwnerPrefix(owner: string): string {
    z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(owner);
    return `sites/owners/${owner}/`;
}
/** Owner advisory lock precedes every site row lock and stays through the write. */
export async function withSiteOwnerAdmission<T>(db: PlatformDB, owner: string, work: (trx: PlatformDB) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
    return db.transaction(async (trx) => {
        await sql `SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
        await sql `SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
        return withAccountDeletionOwnerLock(trx, owner, async (locked, admission) => {
            if (!admission.newWorkAllowed)
                throw new SiteError('unavailable');
            return work(locked);
        }, env);
    });
}
export async function siteOwnerCanServe(db: PlatformDB, owner: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return (await getAccountDeletionAdmission(db, owner, env)).newWorkAllowed;
}
async function registryExists(db: PlatformDB): Promise<boolean> {
    const result = await sql<{
        present: boolean;
    }> `SELECT to_regclass('public_sites') IS NOT NULL AS present`.execute(db.executor);
    return result.rows[0]?.present === true;
}
/** Revoke first; keep DB inventory until private object erasure succeeds so retries remain safe. */
export async function eraseOwnerSites(db: PlatformDB, owner: string, store: AccountDeletionObjectStore | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const present = await registryExists(db);
    await withAccountDeletionOwnerLock(db, owner, async (trx) => {
        if (present) {
            await trx.executor.deleteFrom('public_site_access_links').where('site_id', 'in',
                trx.executor.selectFrom('public_sites').select('id').where('owner_id', '=', owner)).execute();
            await trx.executor.updateTable('public_sites').set({ status: 'unpublished', revision: sql `revision + 1` }).where('owner_id', '=', owner).where('status', '=', 'published').execute();
        }
    }, env);
    const known = present ? await db.executor.selectFrom('public_sites').select('id').where('owner_id', '=', owner).limit(1).executeTakeFirst() : undefined;
    if (!store) {
        if (known)
            throw Error('Sites storage cleanup unavailable');
        return;
    }
    const prefix = siteOwnerPrefix(owner);
    await store.abortOwnerMultipartUploads(prefix);
    const deadline = Date.now() + 20000;
    for (let batch = 0; batch < 100; batch++) {
        if (Date.now() > deadline)
            throw Error('Sites storage cleanup pending');
        const page = await store.listObjects(prefix);
        if (page.keys.length > 1000 || page.keys.some(key => !key.startsWith(prefix)))
            throw Error('Sites storage ownership mismatch');
        if (!page.keys.length) {
            if (page.nextCursor)
                throw Error('Sites storage inventory incomplete');
            return;
        }
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(8, page.keys.length) }, async () => {
            for (;;) {
                const current = index++;
                if (current >= page.keys.length)
                    return;
                if (Date.now() > deadline)
                    throw Error('Sites storage cleanup pending');
                await store.deleteObject(page.keys[current]!);
            }
        }));
    }
    throw Error('Sites storage cleanup pending');
}
/** The deletion data step runs this inside its existing owner-locked transaction.
 * Account erasure retains only anonymous slug reservations; the FK clears every site/owner link. */
export async function eraseOwnerSiteRegistry(db: PlatformDB, owner: string): Promise<void> {
    if (await registryExists(db))
        await db.executor.deleteFrom('public_sites').where('owner_id', '=', owner).execute();
}
