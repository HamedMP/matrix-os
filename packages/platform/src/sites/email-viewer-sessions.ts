import { randomUUID } from 'node:crypto';
import { SITE_VIEWER_SESSION_TTL_MS } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { buildSiteViewerCookie, createSiteAccessSecret, hashSiteAccessSecret } from './access-links.js';
import { readSiteViewerCookie, siteAccessSecretMatches, siteViewerCookieName } from './access-links.js';
import { siteClerkSessionKey, siteRecipientKey } from './email-keys.js';
import { sql } from 'kysely';
import { SiteError } from './types.js';
import { getAccountDeletionAdmission } from '../account-deletion/admission.js';

const MAX_ACTIVE_SESSIONS_PER_GRANT = 20;

/** The caller holds the site row lock and its authority transaction. */
export async function issueEmailViewerSession(
  trx: PlatformDB, siteId: string, grantId: string, clerkSessionKey: string,
): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = randomUUID();
  const secret = createSiteAccessSecret();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SITE_VIEWER_SESSION_TTL_MS);
  await trx.executor.insertInto('public_site_viewer_sessions').values({
    id: sessionId, site_id: siteId, grant_id: grantId, secret_hash: hashSiteAccessSecret(secret),
    clerk_session_key: clerkSessionKey, created_at: createdAt, expires_at: expiresAt,
    last_seen_at: null, revoked_at: null,
  }).execute();
  const active = await trx.executor.selectFrom('public_site_viewer_sessions')
    .select('id').where('grant_id', '=', grantId).where('revoked_at', 'is', null)
    .orderBy('created_at', 'asc').orderBy('id', 'asc')
    .limit(MAX_ACTIVE_SESSIONS_PER_GRANT + 1).forUpdate().execute();
  if (active.length > MAX_ACTIVE_SESSIONS_PER_GRANT) {
    await trx.executor.updateTable('public_site_viewer_sessions').set({ revoked_at: createdAt })
      .where('id', '=', active[0]!.id).where('revoked_at', 'is', null).execute();
  }
  return { sessionId, cookie: buildSiteViewerCookie(siteId, sessionId, secret) };
}

/** Fresh local authority read on every protected content request; no Clerk call. */
export async function authorizeEmailViewerSession(
  db: PlatformDB, siteId: string, cookieHeader: string | undefined, secret: string,
): Promise<boolean> {
  const credential = readSiteViewerCookie(cookieHeader, siteId);
  if (!credential) return false;
  const now = new Date();
  const row = await db.executor.selectFrom('public_site_viewer_sessions as v')
    .innerJoin('public_site_viewer_grants as g', 'g.id', 'v.grant_id')
    .innerJoin('public_site_email_invitations as i', 'i.id', 'g.invitation_id')
    .innerJoin('public_sites as s', 's.id', 'v.site_id')
    .select(['v.secret_hash', 'v.clerk_session_key', 'g.clerk_user_id'])
    .where('v.id', '=', credential.linkId).where('v.site_id', '=', siteId)
    .where('v.revoked_at', 'is', null).where('v.expires_at', '>', now)
    .where('g.site_id', '=', siteId).where('g.revoked_at', 'is', null)
    .where('i.site_id', '=', siteId).where('i.state', '=', 'accepted')
    .whereRef('i.generation', '=', 'g.invitation_generation')
    .whereRef('i.accepted_clerk_user_id', '=', 'g.clerk_user_id')
    .where('s.status', '=', 'published').where('s.access_mode', '=', 'private_email')
    .executeTakeFirst();
  if (!row || !siteAccessSecretMatches(credential.token, row.secret_hash)) return false;
  if (!(await getAccountDeletionAdmission(db, row.clerk_user_id,
    { ACCOUNT_DELETION_SECRET: secret })).newWorkAllowed) return false;
  const termination = await db.executor.selectFrom('public_site_clerk_session_terminations')
    .select('clerk_session_key').where('clerk_session_key', '=', row.clerk_session_key).executeTakeFirst();
  if (termination) return false;
  const lifecycle = await db.executor.selectFrom('public_site_recipient_lifecycle')
    .select('state').where('recipient_key', '=', siteRecipientKey(row.clerk_user_id, secret)).executeTakeFirst();
  return !lifecycle || lifecycle.state === 'active';
}

/** The same advisory key serializes exchange and terminal sign-out across connections. */
export async function terminateEmailClerkSession(
  db: PlatformDB, siteId: string, clerkSessionKey: string, cookieHeader?: string,
): Promise<void> {
  return terminateKey(db, clerkSessionKey, siteId, cookieHeader);
}

/** Main Matrix sign-out uses the same keyed terminal write before Clerk revocation. */
export async function terminateEmailClerkSessionForMatrixSignOut(
  db: PlatformDB, clerkSessionId: string, secret: string,
): Promise<void> {
  return terminateKey(db, siteClerkSessionKey(clerkSessionId, secret));
}

async function terminateKey(
  db: PlatformDB, clerkSessionKey: string, siteId?: string, cookieHeader?: string,
): Promise<void> {
  await db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'site-clerk-session:' + clerkSessionKey}, 0))`.execute(trx.executor);
    const viewerCookieName = siteId ? siteViewerCookieName(siteId) : null;
    const viewerCookiePresent = viewerCookieName && cookieHeader?.split(';')
      .some(value => value.trim().startsWith(`${viewerCookieName}=`));
    const credential = siteId ? readSiteViewerCookie(cookieHeader, siteId) : null;
    if (viewerCookiePresent && !credential) throw new SiteError('not_found');
    if (credential && siteId) {
      const row = await trx.executor.selectFrom('public_site_viewer_sessions')
        .select(['secret_hash', 'clerk_session_key']).where('id', '=', credential.linkId)
        .where('site_id', '=', siteId).executeTakeFirst();
      if (!row || row.clerk_session_key !== clerkSessionKey
        || !siteAccessSecretMatches(credential.token, row.secret_hash)) throw new SiteError('not_found');
    }
    const now = new Date();
    await trx.executor.insertInto('public_site_clerk_session_terminations').values({
      clerk_session_key: clerkSessionKey, terminated_at: now,
      expires_at: new Date(now.getTime() + 31 * 86400_000),
    }).onConflict(oc => oc.column('clerk_session_key').doNothing()).execute();
    await trx.executor.updateTable('public_site_viewer_sessions').set({ revoked_at: now })
      .where('clerk_session_key', '=', clerkSessionKey).where('revoked_at', 'is', null).execute();
  });
}
