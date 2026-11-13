import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { SiteEmailInvitationCreateRequestSchema, SiteEmailInvitationCreateResponseSchema,
  SiteEmailInvitationMutationRequestSchema, SiteEmailInvitationMutationResponseSchema,
  SiteEmailInvitationListQuerySchema, SiteEmailInvitationPageSchema, SiteIdSchema,
  type SiteEmailInvitationSummary } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import type { SiteClerkIdentity } from './clerk-identity.js';
import { appendSiteInvitationAuditEvent } from './invitation-audit.js';
import { issueEmailViewerSession } from './email-viewer-sessions.js';
import { siteClerkSessionKey, siteRecipientKey } from './email-keys.js';
export { siteClerkSessionKey, siteRecipientKey } from './email-keys.js';
import { SiteError } from './types.js';
import type { SiteOwner, SiteEmailInvitationsTable } from './types.js';
import { withSiteOwnerAdmission } from './account-lifecycle.js';
import { assertCurrentPublishingRuntime } from './publish-admission.js';
import type { Selectable } from 'kysely';

const ClerkIdSchema = z.string().regex(/^user_[A-Za-z0-9_-]{1,200}$/);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,200}$/);
const InventoryCursorSchema = z.object({ at: z.iso.datetime(), id: SiteIdSchema }).strict();

function summary(row: Selectable<SiteEmailInvitationsTable>, now = new Date()): SiteEmailInvitationSummary {
  return {
    id: row.id, emailAddress: row.normalized_email,
    state: row.state === 'pending' && row.expires_at <= now ? 'expired' : row.state,
    deliveryState: row.delivery_state,
    generation: Number(row.generation), revision: Number(row.revision),
    issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizedAddress(raw: string): { normalized: string; display: string } | null {
  const display = raw.trim();
  if (display.length < 3 || display.length > 254 || !/^[\x21-\x7e]+$/.test(display)
    || !z.email().max(254).safeParse(display).success) return null;
  return { normalized: display.toLowerCase(), display };
}

const MAX_OWNER_OUTSTANDING_DELIVERIES = 500;
async function assertOwnerDeliveryCapacity(db: PlatformDB, ownerId: string, additional: number, exceptInvitationId?: string) {
  if (!additional) return;
  let query = db.executor.selectFrom('public_site_invitation_deliveries as d')
    .innerJoin('public_site_email_invitations as i', 'i.id', 'd.invitation_id')
    .innerJoin('public_sites as s', 's.id', 'i.site_id')
    .select(sql<number>`count(*)::int`.as('outstanding'))
    .where('s.owner_id', '=', ownerId)
    .where('i.state', '=', 'pending').where('i.expires_at', '>', new Date())
    .where(eb => eb.or([eb('d.failure_code', 'is', null), eb('d.failure_code', '!=', 'rejected')]))
    .where(eb => eb.or([eb('d.state', 'in', ['queued', 'leased']),
      eb.and([eb('d.state', 'in', ['failed', 'ambiguous']), eb('d.attempts', '<', 5)])]));
  if (exceptInvitationId) query = query.where('d.invitation_id', '!=', exceptInvitationId);
  const { outstanding } = await query.executeTakeFirstOrThrow();
  if (outstanding + additional > MAX_OWNER_OUTSTANDING_DELIVERIES) throw new SiteError('unavailable');
}

/** One owner transaction persists inventory, delivery intent, and audit before any mail call. */
export async function createSiteEmailInvitations(db: PlatformDB, owner: SiteOwner, raw: unknown) {
  const parsed = SiteEmailInvitationCreateRequestSchema.safeParse(raw);
  if (!parsed.success) throw new SiteError('invalid_request');
  const input = parsed.data;
  return withSiteOwnerAdmission(db, owner.ownerId, async trx => {
    await assertCurrentPublishingRuntime(trx, owner);
    const site = await trx.executor.selectFrom('public_sites').selectAll()
      .where('owner_id', '=', owner.ownerId).where('machine_id', '=', owner.machineId)
      .where('app_slug', '=', owner.appSlug).forUpdate().executeTakeFirst();
    if (!site || site.status !== 'published' || site.access_mode !== 'private_email') throw new SiteError('not_found');
    if (site.revision !== input.baseRevision) throw new SiteError('conflict');
    const seen = new Set<string>();
    const prepared = input.emailAddresses.map((rawEmail, index) => {
      const address = normalizedAddress(rawEmail);
      if (!address) return { index, outcome: 'invalid' as const };
      if (seen.has(address.normalized)) return { index, outcome: 'duplicate_in_batch' as const };
      seen.add(address.normalized);
      return { index, address };
    });
    const valid = prepared.filter((entry): entry is { index: number; address: { normalized: string; display: string } } => 'address' in entry)
      .sort((a, b) => a.address.normalized.localeCompare(b.address.normalized));
    const rows = valid.length ? await trx.executor.selectFrom('public_site_email_invitations').selectAll()
      .where('site_id', '=', site.id).where('normalized_email', 'in', valid.map(entry => entry.address.normalized))
      .orderBy('normalized_email', 'asc').orderBy('id', 'asc').forUpdate().execute() : [];
    const known = new Map(rows.map(row => [row.normalized_email, row]));
    await assertOwnerDeliveryCapacity(trx, owner.ownerId,
      valid.filter(entry => !known.has(entry.address.normalized)).length);
    const results: Array<Record<string, unknown>> = new Array(input.emailAddresses.length);
    let createdCount = 0;
    for (const entry of prepared) if ('outcome' in entry) results[entry.index] = { inputIndex: entry.index, outcome: entry.outcome };
    for (const entry of valid) {
      const existing = known.get(entry.address.normalized);
      if (existing) { results[entry.index] = { inputIndex: entry.index, outcome: 'existing', invitation: summary(existing) }; continue; }
      const now = new Date();
      const invitationId = randomUUID();
      await trx.executor.insertInto('public_site_email_invitations').values({
        id: invitationId, site_id: site.id, normalized_email: entry.address.normalized,
        display_email: entry.address.display, generation: '1', state: 'pending', delivery_state: 'queued',
        invited_by_clerk_user_id: owner.ownerId, accepted_clerk_user_id: null,
        created_at: now, issued_at: now, expires_at: new Date(now.getTime() + 7 * 86400_000),
        accepted_at: null, revoked_at: null, state_reason: null, updated_at: now, revision: '0',
      }).onConflict(oc => oc.columns(['site_id', 'normalized_email']).doNothing()).execute();
      const inserted = await trx.executor.selectFrom('public_site_email_invitations').selectAll()
        .where('site_id', '=', site.id).where('normalized_email', '=', entry.address.normalized).executeTakeFirstOrThrow();
      if (inserted.id !== invitationId) {
        results[entry.index] = { inputIndex: entry.index, outcome: 'existing', invitation: summary(inserted) };
        continue;
      }
      createdCount++;
      await trx.executor.insertInto('public_site_invitation_deliveries').values({
        id: randomUUID(), invitation_id: invitationId, invitation_generation: '1', idempotency_key: randomUUID(),
        state: 'queued', attempts: 0, available_at: now, lease_token: null, lease_until: null,
        provider_message_id: null, failure_code: null, sent_at: null, created_at: now, updated_at: now,
      }).execute();
      await appendSiteInvitationAuditEvent(trx, { siteId: site.id, invitationId,
        type: 'invitation_created', actorKind: 'owner', actorReference: owner.ownerId, details: { generation: 1 } });
      results[entry.index] = { inputIndex: entry.index, outcome: 'queued', invitation: summary(inserted) };
    }
    const nextRevision = site.revision + (createdCount ? 1 : 0);
    if (createdCount) {
      const updated = await trx.executor.updateTable('public_sites').set({ revision: nextRevision })
        .where('id', '=', site.id).where('revision', '=', site.revision).returning('id').executeTakeFirst();
      if (!updated) throw new SiteError('conflict');
    }
    return SiteEmailInvitationCreateResponseSchema.parse({ results, siteRevision: nextRevision });
  });
}

async function mutateSiteEmailInvitation(
  db: PlatformDB, owner: SiteOwner, invitationId: string, raw: unknown, action: 'resend' | 'revoke',
) {
  const id = SiteIdSchema.safeParse(invitationId);
  const parsed = SiteEmailInvitationMutationRequestSchema.safeParse(raw);
  if (!id.success || !parsed.success) throw new SiteError('invalid_request');
  return withSiteOwnerAdmission(db, owner.ownerId, async trx => {
    await assertCurrentPublishingRuntime(trx, owner);
    const site = await trx.executor.selectFrom('public_sites').selectAll()
      .where('owner_id', '=', owner.ownerId).where('machine_id', '=', owner.machineId)
      .where('app_slug', '=', owner.appSlug).forUpdate().executeTakeFirst();
    if (!site || site.status !== 'published' || site.access_mode !== 'private_email') throw new SiteError('not_found');
    if (site.revision !== parsed.data.baseRevision) throw new SiteError('conflict');
    const invitation = await trx.executor.selectFrom('public_site_email_invitations').selectAll()
      .where('site_id', '=', site.id).where('id', '=', id.data).forUpdate().executeTakeFirst();
    if (!invitation) throw new SiteError('not_found');
    if (Number(invitation.revision) !== parsed.data.invitationRevision) throw new SiteError('conflict');
    const now = new Date();
    const canResend = invitation.state === 'expired' || invitation.state === 'revoked'
      || (invitation.state === 'pending' && (invitation.expires_at <= now
        || ['failed', 'ambiguous', 'suppressed'].includes(invitation.delivery_state)));
    if (action === 'resend' ? !canResend : invitation.state !== 'pending' && invitation.state !== 'accepted')
      throw new SiteError('conflict');
    if (action === 'resend') await assertOwnerDeliveryCapacity(trx, owner.ownerId, 1, id.data);
    const generation = Number(invitation.generation);
    if (!Number.isSafeInteger(generation + 1) || !Number.isSafeInteger(Number(invitation.revision) + 1))
      throw new SiteError('conflict');
    const grants = await trx.executor.selectFrom('public_site_viewer_grants').select('id')
      .where('site_id', '=', site.id).where('invitation_id', '=', id.data)
      .where('revoked_at', 'is', null).orderBy('id', 'asc').forUpdate().execute();
    if (grants.length) {
      await trx.executor.updateTable('public_site_viewer_grants').set({
        revoked_at: now, revocation_reason: action === 'revoke' ? 'owner' : 'reinvited',
      }).where('site_id', '=', site.id).where('invitation_id', '=', id.data)
        .where('revoked_at', 'is', null).execute();
      await trx.executor.updateTable('public_site_viewer_sessions').set({ revoked_at: now })
        .where('grant_id', 'in', grants.map(grant => grant.id)).where('revoked_at', 'is', null).execute();
      await appendSiteInvitationAuditEvent(trx, { siteId: site.id, invitationId: id.data,
        type: 'grant_revoked', actorKind: 'owner', actorReference: owner.ownerId,
        details: { generation, reason: action === 'revoke' ? 'owner' : 'reinvited' } });
    }
    await trx.executor.updateTable('public_site_invitation_deliveries').set({
      state: 'cancelled', lease_token: null, lease_until: null, updated_at: now,
    }).where('invitation_id', '=', id.data).where('invitation_generation', '=', invitation.generation)
      .where('state', 'in', ['queued', 'leased', 'failed', 'ambiguous']).execute();
    const changed = action === 'resend'
      ? await trx.executor.updateTable('public_site_email_invitations').set({
        generation: String(generation + 1), state: 'pending', delivery_state: 'queued',
        accepted_clerk_user_id: null, accepted_at: null, revoked_at: null, state_reason: null,
        issued_at: now, expires_at: new Date(now.getTime() + 7 * 86400_000),
        updated_at: now, revision: String(Number(invitation.revision) + 1),
      }).where('id', '=', id.data).where('site_id', '=', site.id)
        .where('generation', '=', invitation.generation).where('revision', '=', invitation.revision)
        .returningAll().executeTakeFirst()
      : await trx.executor.updateTable('public_site_email_invitations').set({
        state: 'revoked', revoked_at: now, state_reason: 'owner',
        updated_at: now, revision: String(Number(invitation.revision) + 1),
      }).where('id', '=', id.data).where('site_id', '=', site.id)
        .where('generation', '=', invitation.generation).where('revision', '=', invitation.revision)
        .returningAll().executeTakeFirst();
    if (!changed) throw new SiteError('conflict');
    if (action === 'resend') {
      await trx.executor.insertInto('public_site_invitation_deliveries').values({
        id: randomUUID(), invitation_id: id.data, invitation_generation: changed.generation,
        idempotency_key: randomUUID(), state: 'queued', attempts: 0, available_at: now,
        lease_token: null, lease_until: null, provider_message_id: null, failure_code: null,
        sent_at: null, created_at: now, updated_at: now,
      }).execute();
    }
    await appendSiteInvitationAuditEvent(trx, { siteId: site.id, invitationId: id.data,
      type: action === 'resend' ? 'invitation_resent' : 'invitation_revoked',
      actorKind: 'owner', actorReference: owner.ownerId,
      details: { generation: Number(changed.generation), ...(action === 'revoke' ? { reason: 'owner' as const } : {}) } });
    const siteRevision = site.revision + 1;
    const updatedSite = await trx.executor.updateTable('public_sites').set({ revision: siteRevision })
      .where('id', '=', site.id).where('revision', '=', site.revision).returning('id').executeTakeFirst();
    if (!updatedSite) throw new SiteError('conflict');
    return SiteEmailInvitationMutationResponseSchema.parse({ invitation: summary(changed), siteRevision });
  });
}

export function resendSiteEmailInvitation(db: PlatformDB, owner: SiteOwner, invitationId: string, raw: unknown) {
  return mutateSiteEmailInvitation(db, owner, invitationId, raw, 'resend');
}
export function revokeSiteEmailInvitation(db: PlatformDB, owner: SiteOwner, invitationId: string, raw: unknown) {
  return mutateSiteEmailInvitation(db, owner, invitationId, raw, 'revoke');
}

/** Keyset inventory is owner scoped and never projects grant or session secrets. */
export async function listSiteEmailInvitations(db: PlatformDB, owner: SiteOwner, raw: unknown) {
  const parsed = SiteEmailInvitationListQuerySchema.safeParse(raw);
  if (!parsed.success) throw new SiteError('invalid_request');
  let cursor: z.infer<typeof InventoryCursorSchema> | null = null;
  if (parsed.data.cursor) {
    try { cursor = InventoryCursorSchema.parse(JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8'))); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof z.ZodError)
        throw new SiteError('invalid_request');
      throw error;
    }
  }
  const site = await db.executor.selectFrom('public_sites').select(['id', 'revision'])
    .where('owner_id', '=', owner.ownerId).where('machine_id', '=', owner.machineId)
    .where('app_slug', '=', owner.appSlug).executeTakeFirst();
  if (!site) throw new SiteError('not_found');
  let query = db.executor.selectFrom('public_site_email_invitations').selectAll().where('site_id', '=', site.id);
  if (cursor) query = query.where(eb => eb.or([
    eb('updated_at', '<', new Date(cursor!.at)),
    eb.and([eb('updated_at', '=', new Date(cursor!.at)), eb('id', '<', cursor!.id)]),
  ]));
  const rows = await query.orderBy('updated_at', 'desc').orderBy('id', 'desc')
    .limit(parsed.data.limit + 1).execute();
  const page = rows.slice(0, parsed.data.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > parsed.data.limit && last
    ? Buffer.from(JSON.stringify({ at: last.updated_at.toISOString(), id: last.id })).toString('base64url') : null;
  return SiteEmailInvitationPageSchema.parse({ invitations: page.map(row => summary(row)),
    nextCursor, siteRevision: site.revision });
}

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
          delivery_state: sql`CASE WHEN delivery_state IN ('queued','sending','failed','ambiguous')
            THEN 'suppressed' ELSE delivery_state END`,
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
        await admitted.executor.updateTable('public_site_invitation_deliveries').set({
          state: 'cancelled', lease_token: null, lease_until: null, updated_at: now,
        }).where('invitation_id', '=', selected.id)
          .where('state', 'in', ['queued', 'leased', 'failed', 'ambiguous']).execute();
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
