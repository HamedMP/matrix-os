import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { SiteIdSchema } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import type { SiteClerkIdentity } from './clerk-identity.js';
import { appendSiteInvitationAuditEvent } from './invitation-audit.js';
import { issueEmailViewerSession } from './email-viewer-sessions.js';
import { siteClerkSessionKey, siteRecipientKey } from './email-keys.js';
export { siteClerkSessionKey, siteRecipientKey } from './email-keys.js';
import { SiteError } from './types.js';

const ClerkIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,200}$/);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,200}$/);

export interface AcceptSiteEmailInvitationInput {
  db: PlatformDB;
  siteId: string;
  identity: SiteClerkIdentity;
  secret: string;
}

/** Identity must already have been verified against Clerk outside this transaction. */
export async function acceptSiteEmailInvitation(input: AcceptSiteEmailInvitationInput): Promise<{
  grantId: string; sessionId: string; cookie: string;
}> {
  const siteId = SiteIdSchema.parse(input.siteId);
  const userId = ClerkIdSchema.parse(input.identity.clerkUserId);
  const sessionId = SessionIdSchema.parse(input.identity.clerkSessionId);
  const verifiedEmails = [...new Set(input.identity.verifiedEmails.map(email => z.email().max(254).parse(email.trim().toLowerCase())))].sort();
  if (!verifiedEmails.length || verifiedEmails.length > 100) throw new SiteError('not_found');
  const sessionKey = siteClerkSessionKey(sessionId, input.secret);
  const recipientKey = siteRecipientKey(userId, input.secret);
  const env = { ACCOUNT_DELETION_SECRET: input.secret };
  return input.db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    // A session termination can never overtake an admitted exchange.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'site-clerk-session:' + sessionKey}, 0))`.execute(trx.executor);
    const terminated = await trx.executor.selectFrom('public_site_clerk_session_terminations')
      .select('clerk_session_key').where('clerk_session_key', '=', sessionKey).executeTakeFirst();
    if (terminated) throw new SiteError('not_found');
    return withAccountDeletionOwnerLock(trx, userId, async (admitted, admission) => {
      if (!admission.newWorkAllowed) throw new SiteError('not_found');
      const recipient = await admitted.executor.selectFrom('public_site_recipient_lifecycle')
        .select('state').where('recipient_key', '=', recipientKey).forUpdate().executeTakeFirst();
      if (recipient && recipient.state !== 'active') throw new SiteError('not_found');
      const site = await admitted.executor.selectFrom('public_sites').selectAll().where('id', '=', siteId)
        .where('status', '=', 'published').where('access_mode', '=', 'private_email')
        .forUpdate().executeTakeFirst();
      if (!site) throw new SiteError('not_found');
      const ownerAdmission = await getAccountDeletionAdmission(admitted, site.owner_id, env);
      if (!ownerAdmission.newWorkAllowed) throw new SiteError('not_found');
      const machine = await admitted.executor.selectFrom('user_machines').select('machine_id')
        .where('machine_id', '=', site.machine_id).where('clerk_user_id', '=', site.owner_id)
        .where('deleted_at', 'is', null).where('status', '!=', 'deleted').executeTakeFirst();
      if (!machine) throw new SiteError('not_found');
      let grant = await admitted.executor.selectFrom('public_site_viewer_grants as g')
        .innerJoin('public_site_email_invitations as i', 'i.id', 'g.invitation_id')
        .select(['g.id', 'g.invitation_generation'])
        .where('g.site_id', '=', siteId).where('g.clerk_user_id', '=', userId).where('g.revoked_at', 'is', null)
        .where('i.state', '=', 'accepted').where('i.accepted_clerk_user_id', '=', userId)
        .whereRef('i.generation', '=', 'g.invitation_generation').executeTakeFirst();
      if (!grant) {
        const now = new Date();
        const invitations = await admitted.executor.selectFrom('public_site_email_invitations').selectAll()
          .where('site_id', '=', siteId).where('normalized_email', 'in', verifiedEmails)
          .orderBy('normalized_email', 'asc').orderBy('id', 'asc').forUpdate().execute();
        const selected = invitations.find(row => row.state === 'pending' && row.expires_at > now);
        if (!selected) throw new SiteError('not_found');
        const accepted = await admitted.executor.updateTable('public_site_email_invitations').set({
          state: 'accepted', accepted_clerk_user_id: userId, accepted_at: now,
          updated_at: now, revision: sql`revision + 1`,
        }).where('id', '=', selected.id).where('site_id', '=', siteId)
          .where('normalized_email', '=', selected.normalized_email).where('generation', '=', selected.generation)
          .where('state', '=', 'pending').where('expires_at', '>', now)
          .where('accepted_clerk_user_id', 'is', null).returning('id').executeTakeFirst();
        if (!accepted) throw new SiteError('not_found');
        const grantId = randomUUID();
        await admitted.executor.insertInto('public_site_viewer_grants').values({
          id: grantId, site_id: siteId, invitation_id: selected.id, invitation_generation: selected.generation,
          clerk_user_id: userId, granted_at: now, revoked_at: null, revocation_reason: null,
        }).onConflict(oc => oc.columns(['invitation_id', 'invitation_generation']).doNothing()).execute();
        grant = await admitted.executor.selectFrom('public_site_viewer_grants')
          .select(['id', 'invitation_generation']).where('invitation_id', '=', selected.id)
          .where('invitation_generation', '=', selected.generation).where('clerk_user_id', '=', userId)
          .where('revoked_at', 'is', null).executeTakeFirst();
        if (!grant) throw new SiteError('not_found');
        await appendSiteInvitationAuditEvent(admitted, { siteId, invitationId: selected.id,
          type: 'invitation_accepted', actorKind: 'viewer', actorReference: userId,
          details: { generation: Number(selected.generation) } });
        for (const alias of invitations) {
          if (alias.id === selected.id || alias.state !== 'pending') continue;
          await admitted.executor.updateTable('public_site_email_invitations').set({ state: 'revoked', revoked_at: now,
            state_reason: 'duplicate_identity', updated_at: now, revision: sql`revision + 1` })
            .where('id', '=', alias.id).where('state', '=', 'pending').execute();
          await admitted.executor.updateTable('public_site_invitation_deliveries').set({ state: 'cancelled', updated_at: now,
            lease_token: null, lease_until: null }).where('invitation_id', '=', alias.id)
            .where('state', 'in', ['queued', 'failed', 'ambiguous']).execute();
          await appendSiteInvitationAuditEvent(admitted, { siteId, invitationId: alias.id,
            type: 'invitation_revoked', actorKind: 'system', actorReference: null,
            details: { generation: Number(alias.generation), reason: 'duplicate_identity' } });
        }
      }
      const issued = await issueEmailViewerSession(admitted, siteId, grant.id, sessionKey);
      return { grantId: grant.id, ...issued };
    }, env);
  });
}
