import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { appendSiteInvitationAuditEvent } from './invitation-audit.js';
import type { SiteInvitationMail, SiteInvitationMailer, SiteInvitationMailResult } from './invitation-mailer.js';

interface Job { id: string; invitationId: string; generation: string; leaseToken: string;
  idempotencyKey: string; email: string; siteId: string; title: string; expiresAt: Date; attempts: number; }
const MAX_BATCH = 25;
const MAIL_TIMEOUT_MS = 10_000;
const LEASE_MS = 5 * 60_000;

async function claim(db: PlatformDB): Promise<Job[]> {
  return db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    const now = new Date();
    const rows = await trx.executor.selectFrom('public_site_invitation_deliveries as d')
      .innerJoin('public_site_email_invitations as i', 'i.id', 'd.invitation_id')
      .innerJoin('public_sites as s', 's.id', 'i.site_id')
      .select(['d.id', 'd.invitation_id', 'd.invitation_generation', 'd.idempotency_key', 'd.attempts',
        'i.normalized_email', 'i.expires_at', 's.id as site_id', 's.title'])
      .where('d.available_at', '<=', now).where('d.attempts', '<', 5)
      .where(eb => eb.or([eb('d.failure_code', 'is', null), eb('d.failure_code', '!=', 'rejected')]))
      .where(eb => eb.or([eb('d.state', 'in', ['queued', 'failed', 'ambiguous']),
        eb.and([eb('d.state', '=', 'leased'), eb('d.lease_until', '<=', now)])]))
      .whereRef('i.generation', '=', 'd.invitation_generation')
      .where('i.state', '=', 'pending').where('i.expires_at', '>', now)
      .where('s.status', '=', 'published').where('s.access_mode', '=', 'private_email')
      .orderBy('d.available_at', 'asc').orderBy('d.id', 'asc').limit(MAX_BATCH)
      .forUpdate('d').skipLocked().execute();
    const jobs: Job[] = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const changed = await trx.executor.updateTable('public_site_invitation_deliveries')
        .set({ state: 'leased', attempts: row.attempts + 1, lease_token: leaseToken,
          lease_until: new Date(now.getTime() + LEASE_MS), updated_at: now })
        .where('id', '=', row.id).where('attempts', '=', row.attempts).returning('id').executeTakeFirst();
      if (!changed) continue;
      jobs.push({ id: row.id, invitationId: row.invitation_id, generation: row.invitation_generation,
        leaseToken, idempotencyKey: row.idempotency_key, email: row.normalized_email,
        siteId: row.site_id, title: row.title, expiresAt: row.expires_at, attempts: row.attempts + 1 });
    }
    return jobs;
  });
}

async function sweepExpiredAndRetained(db: PlatformDB): Promise<void> {
  const now = new Date();
  const expired = await db.executor.selectFrom('public_site_email_invitations')
    .select(['id', 'site_id']).where('state', '=', 'pending').where('expires_at', '<=', now)
    .orderBy('expires_at', 'asc').orderBy('id', 'asc').limit(MAX_BATCH).execute();
  for (const candidate of expired) {
    await db.transaction(async trx => {
      await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
      await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
      await trx.executor.selectFrom('public_sites').select('id')
        .where('id', '=', candidate.site_id).forUpdate().executeTakeFirst();
      const invitation = await trx.executor.selectFrom('public_site_email_invitations')
        .select(['id', 'state', 'expires_at']).where('id', '=', candidate.id)
        .where('site_id', '=', candidate.site_id).forUpdate().executeTakeFirst();
      if (invitation?.state !== 'pending' || invitation.expires_at > now) return;
      await trx.executor.updateTable('public_site_invitation_deliveries').set({
        state: 'cancelled', lease_token: null, lease_until: null, updated_at: now,
      }).where('invitation_id', '=', candidate.id)
        .where('state', 'in', ['queued', 'leased', 'failed', 'ambiguous']).execute();
      await trx.executor.updateTable('public_site_email_invitations').set({
        state: 'expired', updated_at: now, revision: sql`revision + 1`,
      }).where('id', '=', candidate.id).where('state', '=', 'pending')
        .where('expires_at', '<=', now).execute();
    });
  }
  const cutoff = new Date(now.getTime() - 30 * 86400_000);
  await db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    const old = await trx.executor.selectFrom('public_site_invitation_deliveries')
      .select('id').where('updated_at', '<', cutoff)
      .where(eb => eb.or([eb('state', 'in', ['sent', 'cancelled']),
        eb.and([eb('state', 'in', ['failed', 'ambiguous']), eb('attempts', '=', 5)])]))
      .orderBy('updated_at', 'asc').orderBy('id', 'asc')
      .limit(MAX_BATCH).forUpdate().skipLocked().execute();
    if (old.length) await trx.executor.deleteFrom('public_site_invitation_deliveries')
      .where('id', 'in', old.map(row => row.id)).execute();
  });
}

/** Recheck authority after the lease commits and before any external mail call. */
async function markSending(db: PlatformDB, job: Job): Promise<boolean> {
  return db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    const site = await trx.executor.selectFrom('public_sites').select(['status', 'access_mode'])
      .where('id', '=', job.siteId).forUpdate().executeTakeFirst();
    const invitation = await trx.executor.selectFrom('public_site_email_invitations')
      .select(['state', 'generation', 'expires_at']).where('id', '=', job.invitationId)
      .where('site_id', '=', job.siteId).forUpdate().executeTakeFirst();
    const delivery = await trx.executor.selectFrom('public_site_invitation_deliveries')
      .select(['state', 'lease_token', 'invitation_generation'])
      .where('id', '=', job.id).where('invitation_id', '=', job.invitationId)
      .forUpdate().executeTakeFirst();
    if (!delivery || delivery.state !== 'leased' || delivery.lease_token !== job.leaseToken
      || delivery.invitation_generation !== job.generation) return false;
    const now = new Date();
    if (!site || site.status !== 'published' || site.access_mode !== 'private_email'
      || !invitation || invitation.state !== 'pending' || invitation.generation !== job.generation
      || invitation.expires_at <= now) {
      await trx.executor.updateTable('public_site_invitation_deliveries').set({
        state: 'cancelled', lease_token: null, lease_until: null, updated_at: now,
      }).where('id', '=', job.id).where('lease_token', '=', job.leaseToken).execute();
      return false;
    }
    await trx.executor.updateTable('public_site_email_invitations').set({
      delivery_state: 'sending', updated_at: now,
    }).where('id', '=', job.invitationId).where('generation', '=', job.generation)
      .where('state', '=', 'pending').execute();
    return true;
  });
}

async function sendBounded(mailer: SiteInvitationMailer, job: Job): Promise<SiteInvitationMailResult> {
  const input: SiteInvitationMail = { idempotencyKey: job.idempotencyKey, invitationId: job.invitationId,
    generation: Number(job.generation), email: job.email, siteId: job.siteId,
    url: `https://matrix.page/${job.siteId}`, title: job.title, expiresAt: job.expiresAt };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mailer.send(input, controller.signal),
      new Promise<SiteInvitationMailResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'ambiguous' }); }, MAIL_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn('[sites] invitation mail unavailable', error instanceof Error ? error.name : 'UnknownError');
    return { kind: 'ambiguous' };
  } finally { if (timer) clearTimeout(timer); }
}

async function complete(db: PlatformDB, job: Job, outcome: SiteInvitationMailResult): Promise<boolean> {
  return db.transaction(async trx => {
    await sql`SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
    await sql`SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
    const site = await trx.executor.selectFrom('public_sites').select(['id', 'status', 'access_mode'])
      .where('id', '=', job.siteId).forUpdate().executeTakeFirst();
    const invitation = await trx.executor.selectFrom('public_site_email_invitations').selectAll()
      .where('id', '=', job.invitationId).where('site_id', '=', job.siteId).forUpdate().executeTakeFirst();
    const delivery = await trx.executor.selectFrom('public_site_invitation_deliveries').selectAll()
      .where('id', '=', job.id).where('invitation_id', '=', job.invitationId).forUpdate().executeTakeFirst();
    if (!delivery || delivery.state !== 'leased' || delivery.lease_token !== job.leaseToken
      || delivery.invitation_generation !== job.generation) return false;
    const now = new Date();
    if (!site || site.status !== 'published' || site.access_mode !== 'private_email'
      || !invitation || invitation.state !== 'pending' || invitation.generation !== job.generation
      || invitation.expires_at <= now) {
      await trx.executor.updateTable('public_site_invitation_deliveries').set({
        state: 'cancelled', lease_token: null, lease_until: null, updated_at: now,
      }).where('id', '=', job.id).where('lease_token', '=', job.leaseToken).execute();
      return false;
    }
    const sent = outcome.kind === 'sent';
    const retryable = !sent && outcome.kind !== 'permanent' && job.attempts < 5;
    const nextState = sent ? 'sent' : outcome.kind === 'ambiguous' ? 'ambiguous' : 'failed';
    const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, job.attempts - 1));
    const changed = await trx.executor.updateTable('public_site_invitation_deliveries').set({
      state: nextState, lease_token: null, lease_until: null, updated_at: now,
      available_at: retryable ? new Date(now.getTime() + delay) : now,
      sent_at: sent ? now : null, provider_message_id: sent ? outcome.messageId?.slice(0, 255) ?? null : null,
      failure_code: sent ? null : outcome.kind === 'ambiguous' ? 'timeout' : outcome.kind === 'permanent' ? 'rejected' : 'unavailable',
    }).where('id', '=', job.id).where('lease_token', '=', job.leaseToken)
      .where('invitation_generation', '=', job.generation).where('state', '=', 'leased').returning('id').executeTakeFirst();
    if (!changed) return false;
    await trx.executor.updateTable('public_site_email_invitations').set({
      delivery_state: sent ? 'sent' : outcome.kind === 'ambiguous' ? 'ambiguous'
        : outcome.kind === 'permanent' ? 'suppressed' : 'failed', updated_at: now,
    }).where('id', '=', job.invitationId).where('site_id', '=', job.siteId)
      .where('generation', '=', job.generation).where('state', '=', 'pending').execute();
    await appendSiteInvitationAuditEvent(trx, { siteId: job.siteId, invitationId: job.invitationId,
      type: sent ? 'delivery_sent' : 'delivery_failed', actorKind: 'system', actorReference: null,
      details: { generation: Number(job.generation), ...(!sent ? { reason: outcome.kind === 'ambiguous' ? 'timeout' as const : outcome.kind === 'permanent' ? 'rejected' as const : 'unavailable' as const } : {}) } });
    return sent;
  });
}

export function createSiteInvitationDeliveryWorker(options: { db: PlatformDB; mailer: SiteInvitationMailer; intervalMs?: number }) {
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<{ claimed: number; sent: number }> | undefined;
  async function runOnce(): Promise<{ claimed: number; sent: number }> {
    if (closed) return { claimed: 0, sent: 0 };
    if (active) return active;
    active = (async () => {
      await sweepExpiredAndRetained(options.db);
      const jobs = await claim(options.db);
      let index = 0, sent = 0;
      await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, async () => {
        for (;;) {
          const job = jobs[index++]; if (!job) return;
          if (!await markSending(options.db, job)) continue;
          const result = await sendBounded(options.mailer, job);
          if (await complete(options.db, job, result)) sent++;
        }
      }));
      return { claimed: jobs.length, sent };
    })();
    try { return await active; }
    finally { active = undefined; }
  }
  function start() {
    if (closed || timer) return;
    timer = setInterval(() => { void runOnce().catch(error => console.warn('[sites] invitation delivery cycle failed',
      error instanceof Error ? error.name : 'UnknownError')); }, options.intervalMs ?? 30_000);
    timer.unref?.();
  }
  async function close() {
    closed = true;
    if (timer) { clearInterval(timer); timer = undefined; }
    if (active) await Promise.race([active.catch(error => console.warn('[sites] invitation delivery drain failed',
      error instanceof Error ? error.name : 'UnknownError')), new Promise<void>(resolve => setTimeout(resolve, 5000))]);
  }
  return { runOnce, start, close };
}
