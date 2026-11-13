import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB, type PlatformDatabase } from '../../packages/platform/src/db.js';
import { acceptSiteEmailInvitation, createSiteEmailInvitations, listSiteEmailInvitations,
  resendSiteEmailInvitation, revokeSiteEmailInvitation, siteClerkSessionKey, siteRecipientKey } from '../../packages/platform/src/sites/email-invitations.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { authorizeEmailViewerSession, terminateEmailClerkSessionForMatrixSignOut } from '../../packages/platform/src/sites/email-viewer-sessions.js';
import { recordSiteRecipientLifecycle } from '../../packages/platform/src/sites/account-lifecycle.js';
import { wrapPlatformDb } from '../../packages/platform/src/database/transaction-scope.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';

const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const postgres = postgresUrl ? describe : describe.skip;
postgres('site email invitations across independent PostgreSQL connections', () => {
  const schema = `site_email_${randomUUID().replaceAll('-', '')}`;
  const secret = 'site-email-test-secret-that-is-long-enough';
  let admin: pg.Pool;
  let dbA: PlatformDB;
  let dbB: PlatformDB;
  function url(name: string) {
    const parsed = new URL(postgresUrl!);
    if (!parsed.pathname.includes('test')) throw Error('Test database required');
    parsed.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=10000`);
    parsed.searchParams.set('application_name', name);
    return parsed.toString();
  }
  async function seed(address = 'recipient@example.com', expiresAt = new Date(Date.now() + 7 * 86400_000)) {
    const siteId = randomUUID(), invitationId = randomUUID();
    await dbA.executor.insertInto('public_sites').values({ id: siteId, owner_id: 'user_site_owner', machine_id: 'owner-machine',
      app_slug: `app-${siteId}`, title: 'Shared app', description: '', slug: null, revision: 1,
      status: 'published', access_mode: 'private_email', active_version: null, created_at: new Date().toISOString() }).execute();
    const now = new Date();
    const issuedAt = new Date(expiresAt.getTime() - 7 * 86400_000);
    await dbA.executor.insertInto('public_site_email_invitations').values({ id: invitationId, site_id: siteId,
      normalized_email: address, display_email: address, generation: '1', state: 'pending', delivery_state: 'queued',
      invited_by_clerk_user_id: 'user_site_owner', accepted_clerk_user_id: null, created_at: issuedAt,
      issued_at: issuedAt, expires_at: expiresAt, accepted_at: null, revoked_at: null, state_reason: null,
      updated_at: now, revision: '0' }).execute();
    return { siteId, invitationId };
  }
  const recipient = { clerkUserId: 'user_invited', clerkSessionId: 'sess_invited_browser', verifiedEmails: ['recipient@example.com'] };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dbA = createPlatformDb(url('email-accept-a')); await dbA.ready;
    dbB = createPlatformDb(url('email-accept-b')); await dbB.ready;
    await insertUserMachine(dbA, { machineId: 'owner-machine', clerkUserId: 'user_site_owner', handle: 'site-email-owner', status: 'running', provisionedAt: new Date().toISOString() });
  });
  afterAll(async () => {
    await Promise.all([dbA?.destroy(), dbB?.destroy()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });

  it('converges 100 concurrent exchanges on one grant without partial invitation or audit writes', async () => {
    const { siteId, invitationId } = await seed();
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
      acceptSiteEmailInvitation({ db: index % 2 ? dbA : dbB, siteId, identity: recipient, secret })));
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const grants = await dbA.executor.selectFrom('public_site_viewer_grants').selectAll().where('site_id', '=', siteId).execute();
    const sessions = await dbA.executor.selectFrom('public_site_viewer_sessions').selectAll().where('site_id', '=', siteId).where('revoked_at', 'is', null).execute();
    const invitation = await dbA.executor.selectFrom('public_site_email_invitations').selectAll().where('id', '=', invitationId).executeTakeFirstOrThrow();
    const events = await dbA.executor.selectFrom('public_site_access_audit_events').selectAll().where('site_id', '=', siteId).execute();
    expect(grants).toHaveLength(1);
    expect(sessions.length).toBeLessThanOrEqual(20);
    expect(invitation).toMatchObject({ state: 'accepted', accepted_clerk_user_id: recipient.clerkUserId });
    expect(events.filter(event => event.event_type === 'invitation_accepted')).toHaveLength(1);
  });

  it('creates ordered normalized owner results and a committed outbox before delivery', async () => {
    const {siteId}=await seed();
    const owner={ownerId:'user_site_owner',machineId:'owner-machine',appSlug:`app-${siteId}`};
    const created=await createSiteEmailInvitations(dbA,owner,{baseRevision:1,emailAddresses:[
      '  ADA@example.com  ','ada@EXAMPLE.com','bad address','recipient@example.com','bob+notes@example.com','',
    ]});
    expect(created.results.map(result=>result.outcome)).toEqual(['queued','duplicate_in_batch','invalid','existing','queued','invalid']);
    expect(created.results[0]).toMatchObject({invitation:{emailAddress:'ada@example.com',state:'pending',generation:1}});
    expect(created.siteRevision).toBe(2);
    const rows=await dbB.executor.selectFrom('public_site_email_invitations').selectAll().where('site_id','=',siteId).execute();
    expect(rows).toHaveLength(3);
    const deliveries=await dbB.executor.selectFrom('public_site_invitation_deliveries').selectAll()
      .where('invitation_id','in',rows.filter(row=>row.normalized_email!=='recipient@example.com').map(row=>row.id)).execute();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(row=>row.state==='queued')).toBe(true);
    const audit=await dbB.executor.selectFrom('public_site_access_audit_events').selectAll().where('site_id','=',siteId).execute();
    expect(audit.filter(row=>row.event_type==='invitation_created')).toHaveLength(2);
    const page=await listSiteEmailInvitations(dbB,owner,{limit:2});
    expect(page.invitations).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    expect(page.invitations.every(row=>!('acceptedClerkUserId' in row))).toBe(true);
    const next=await listSiteEmailInvitations(dbB,owner,{limit:2,cursor:page.nextCursor!});
    expect(next.invitations).toHaveLength(1);
    await expect(createSiteEmailInvitations(dbB,owner,{baseRevision:1,emailAddresses:['new@example.com']}))
      .rejects.toMatchObject({code:'conflict'});
  });

  it('resends a failed invitation with one new generation and cancels stale delivery work', async () => {
    const {siteId,invitationId}=await seed('retry@example.com');
    const owner={ownerId:'user_site_owner',machineId:'owner-machine',appSlug:`app-${siteId}`};
    const now=new Date();
    await dbA.executor.insertInto('public_site_invitation_deliveries').values({id:randomUUID(),invitation_id:invitationId,
      invitation_generation:'1',idempotency_key:randomUUID(),state:'failed',attempts:1,available_at:now,
      lease_token:null,lease_until:null,provider_message_id:null,failure_code:'timeout',sent_at:null,created_at:now,updated_at:now}).execute();
    await dbA.executor.updateTable('public_site_email_invitations').set({delivery_state:'failed'}).where('id','=',invitationId).execute();
    const resent=await resendSiteEmailInvitation(dbA,owner,invitationId,{baseRevision:1,invitationRevision:0});
    expect(resent).toMatchObject({siteRevision:2,invitation:{id:invitationId,generation:2,state:'pending',deliveryState:'queued'}});
    const deliveries=await dbB.executor.selectFrom('public_site_invitation_deliveries').selectAll().where('invitation_id','=',invitationId)
      .orderBy('invitation_generation','asc').execute();
    expect(deliveries.map(row=>row.state)).toEqual(['cancelled','queued']);
    await expect(resendSiteEmailInvitation(dbB,owner,invitationId,{baseRevision:2,invitationRevision:0}))
      .rejects.toMatchObject({code:'conflict'});
  });

  it('revokes an accepted invitation, grant, sessions, and delivery in one owner transaction', async () => {
    const {siteId,invitationId}=await seed('revoke@example.com');
    const owner={ownerId:'user_site_owner',machineId:'owner-machine',appSlug:`app-${siteId}`};
    const identity={...recipient,clerkSessionId:'sess_revoke',verifiedEmails:['revoke@example.com']};
    const issued=await acceptSiteEmailInvitation({db:dbA,siteId,identity,secret});
    expect(await authorizeEmailViewerSession(dbB,siteId,issued.cookie,secret)).toBe(true);
    const response=await revokeSiteEmailInvitation(dbA,owner,invitationId,{baseRevision:1,invitationRevision:1});
    expect(response).toMatchObject({siteRevision:2,invitation:{state:'revoked'}});
    expect(await authorizeEmailViewerSession(dbB,siteId,issued.cookie,secret)).toBe(false);
    expect((await dbB.executor.selectFrom('public_site_viewer_grants').selectAll().where('id','=',issued.grantId)
      .executeTakeFirstOrThrow()).revocation_reason).toBe('owner');
    expect((await dbB.executor.selectFrom('public_site_viewer_sessions').selectAll().where('id','=',issued.sessionId)
      .executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect(await dbB.executor.selectFrom('public_site_access_audit_events').select('event_type')
      .where('invitation_id','=',invitationId).where('event_type','=','invitation_revoked').execute()).toHaveLength(1);
    await expect(revokeSiteEmailInvitation(dbB,owner,invitationId,{baseRevision:1,invitationRevision:1}))
      .rejects.toMatchObject({code:'conflict'});
  });

  it('admits only one of two matching identities and rejects expiry or a terminated Clerk session', async () => {
    const { siteId } = await seed('shared@example.com');
    const attempts = await Promise.allSettled([
      acceptSiteEmailInvitation({ db: dbA, siteId, identity: { ...recipient, verifiedEmails: ['shared@example.com'] }, secret }),
      acceptSiteEmailInvitation({ db: dbB, siteId, identity: { clerkUserId: 'user_other', clerkSessionId: 'sess_other', verifiedEmails: ['shared@example.com'] }, secret }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id').where('site_id', '=', siteId).execute()).toHaveLength(1);

    const expired = await seed('expired@example.com', new Date(Date.now() - 1000));
    await expect(acceptSiteEmailInvitation({ db: dbA, siteId: expired.siteId,
      identity: { ...recipient, verifiedEmails: ['expired@example.com'] }, secret })).rejects.toMatchObject({ code: 'not_found' });
    const terminated = await seed('terminated@example.com');
    await sql`INSERT INTO public_site_clerk_session_terminations (clerk_session_key, terminated_at, expires_at)
      VALUES (${siteClerkSessionKey(recipient.clerkSessionId, secret)}, now(), now() + interval '31 days')`.execute(dbA.executor);
    await expect(acceptSiteEmailInvitation({ db: dbB, siteId: terminated.siteId,
      identity: { ...recipient, verifiedEmails: ['terminated@example.com'] }, secret })).rejects.toMatchObject({ code: 'not_found' });
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id').where('site_id', '=', terminated.siteId).execute()).toEqual([]);
  });

  it('evicts the oldest browser session when a grant receives its 21st exchange', async () => {
    const { siteId } = await seed('cap@example.com');
    const identity = { ...recipient, clerkSessionId: 'sess_cap', verifiedEmails: ['cap@example.com'] };
    const first = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    for (let index = 1; index < 21; index++) await acceptSiteEmailInvitation({ db: index % 2 ? dbA : dbB, siteId, identity, secret });
    const active = await dbA.executor.selectFrom('public_site_viewer_sessions').selectAll().where('site_id', '=', siteId).where('revoked_at', 'is', null).execute();
    expect(active).toHaveLength(20);
    expect(active.some(session => session.id === first.sessionId)).toBe(false);
  });

  it('waits behind recipient deletion admission and refuses a grant after deletion is accepted', async () => {
    const { siteId } = await seed('deleting@example.com');
    const recipientId = 'user_deleting';
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const repository = new AccountDeletionRepository(dbB.kysely, { secret });
    const deletion = repository.acceptPrepared(recipientId, false, async () => {
      began.resolve();
      await release.promise;
      return { clerkUserId: recipientId, appleTokens: [] };
    });
    await began.promise;
    const acceptance = acceptSiteEmailInvitation({ db: dbA, siteId,
      identity: { clerkUserId: recipientId, clerkSessionId: 'sess_deleting', verifiedEmails: ['deleting@example.com'] }, secret });
    try {
      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const waiters = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='email-accept-a' AND wait_event_type='Lock'");
        if (waiters.rows[0].count > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release.resolve(); await deletion; }
    await expect(acceptance).rejects.toMatchObject({ code: 'not_found' });
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id').where('site_id', '=', siteId).execute()).toEqual([]);
  });

  it('denies an existing viewer session as soon as recipient account deletion is scheduled', async () => {
    const { siteId } = await seed('scheduled@example.com');
    const identity = { clerkUserId: 'user_scheduled', clerkSessionId: 'sess_scheduled',
      verifiedEmails: ['scheduled@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    expect(await authorizeEmailViewerSession(dbB, siteId, issued.cookie, secret)).toBe(true);
    const repository = new AccountDeletionRepository(dbB.kysely, { secret });
    await repository.acceptPrepared(identity.clerkUserId, false, async () => ({
      clerkUserId: identity.clerkUserId, appleTokens: [],
    }));
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
  });

  it('serializes acceptance and main Matrix sign-out across independent PostgreSQL connections', async () => {
    const { siteId } = await seed('signout-race@example.com');
    const identity = { clerkUserId: 'user_signout_race', clerkSessionId: 'sess_signout_race',
      verifiedEmails: ['signout-race@example.com'] };
    const [accepted, terminated] = await Promise.allSettled([
      acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }),
      terminateEmailClerkSessionForMatrixSignOut(dbB, identity.clerkSessionId, secret),
    ]);
    expect(terminated.status).toBe('fulfilled');
    if (accepted.status === 'fulfilled') {
      expect(await authorizeEmailViewerSession(dbB, siteId, accepted.value.cookie, secret)).toBe(false);
    }
    await expect(acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }))
      .rejects.toMatchObject({ code: 'not_found' });
    const live = await dbB.executor.selectFrom('public_site_viewer_sessions').select('id')
      .where('site_id', '=', siteId).where('revoked_at', 'is', null).execute();
    expect(live).toHaveLength(0);
  });

  it('revokes recipient grants on inactivation and keeps deleted identities terminal under stale events', async () => {
    const { siteId } = await seed('inactive@example.com');
    const identity = { clerkUserId: 'user_inactive', clerkSessionId: 'sess_inactive',
      verifiedEmails: ['inactive@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    const eventAt = new Date();
    await recordSiteRecipientLifecycle(dbB, { userId: identity.clerkUserId, state: 'inactive',
      eventId: 'evt_inactive', eventAt, secret });
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
    expect((await dbA.executor.selectFrom('public_site_viewer_grants').select('revocation_reason')
      .where('id', '=', issued.grantId).executeTakeFirstOrThrow()).revocation_reason).toBe('recipient_inactive');
    await expect(acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }))
      .rejects.toMatchObject({ code: 'not_found' });
    await recordSiteRecipientLifecycle(dbA, { userId: identity.clerkUserId, state: 'active',
      eventId: 'evt_same_time_active', eventAt, secret });
    expect((await dbB.executor.selectFrom('public_site_recipient_lifecycle').select('state')
      .where('recipient_key', '=', siteRecipientKey(identity.clerkUserId, secret))
      .executeTakeFirstOrThrow()).state).toBe('inactive');
    await recordSiteRecipientLifecycle(dbA, { userId: identity.clerkUserId, state: 'active',
      eventId: 'evt_reactivated', eventAt: new Date(eventAt.getTime() + 500), secret });
    expect(await authorizeEmailViewerSession(dbB, siteId, issued.cookie, secret)).toBe(false);
    await recordSiteRecipientLifecycle(dbB, { userId: identity.clerkUserId, state: 'deleted',
      eventId: 'evt_deleted', eventAt: new Date(eventAt.getTime() + 1000), secret });
    await recordSiteRecipientLifecycle(dbA, { userId: identity.clerkUserId, state: 'active',
      eventId: 'evt_stale', eventAt: new Date(eventAt.getTime() - 1000), secret });
    expect((await dbB.executor.selectFrom('public_site_recipient_lifecycle').select('state')
      .where('recipient_key', '=', siteRecipientKey(identity.clerkUserId, secret))
      .executeTakeFirstOrThrow()).state).toBe('deleted');
    expect((await dbB.executor.selectFrom('public_site_viewer_grants').select('clerk_user_id')
      .where('id', '=', issued.grantId).executeTakeFirstOrThrow()).clerk_user_id)
      .toBe(`deleted:${siteRecipientKey(identity.clerkUserId, secret)}`);
    expect((await dbB.executor.selectFrom('public_site_email_invitations').select('accepted_clerk_user_id')
      .where('site_id', '=', siteId).executeTakeFirstOrThrow()).accepted_clerk_user_id)
      .toBe(`deleted:${siteRecipientKey(identity.clerkUserId, secret)}`);
    expect(await dbB.executor.selectFrom('public_site_access_audit_events').select('actor_reference')
      .where('site_id', '=', siteId).where('actor_reference', '=', identity.clerkUserId).execute()).toHaveLength(0);
  });

  it('serializes signed inactivation against acceptance across independent connections', async () => {
    const { siteId } = await seed('inactive-race@example.com');
    const identity = { clerkUserId: 'user_inactive_race', clerkSessionId: 'sess_inactive_race',
      verifiedEmails: ['inactive-race@example.com'] };
    const [accepted, inactive] = await Promise.allSettled([
      acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }),
      recordSiteRecipientLifecycle(dbB, { userId: identity.clerkUserId, state: 'inactive',
        eventId: 'evt_inactive_race', eventAt: new Date(), secret }),
    ]);
    expect(inactive.status).toBe('fulfilled');
    if (accepted.status === 'fulfilled')
      expect(await authorizeEmailViewerSession(dbA, siteId, accepted.value.cookie, secret)).toBe(false);
    await expect(acceptSiteEmailInvitation({ db: dbB, siteId, identity, secret }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await dbB.executor.selectFrom('public_site_viewer_sessions').select('id')
      .where('site_id', '=', siteId).where('revoked_at', 'is', null).execute()).toHaveLength(0);
  });

  it('revokes email authority and queued delivery when a mode change races acceptance, without restoring it on reentry', async () => {
    const { siteId, invitationId } = await seed('mode-race@example.com');
    const now = new Date();
    await dbA.executor.insertInto('public_site_invitation_deliveries').values({ id: randomUUID(),
      invitation_id: invitationId, invitation_generation: '1', idempotency_key: randomUUID(),
      state: 'queued', attempts: 0, available_at: now, lease_token: null, lease_until: null,
      provider_message_id: null, failure_code: null, sent_at: null, created_at: now, updated_at: now }).execute();
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    const identity = { clerkUserId: 'user_mode_race', clerkSessionId: 'sess_mode_race',
      verifiedEmails: ['mode-race@example.com'] };
    const [accepted, changed] = await Promise.allSettled([
      acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }),
      service.patch(owner, { accessMode: 'public', baseRevision: 1 }),
    ]);
    expect(changed.status).toBe('fulfilled');
    if (accepted.status === 'fulfilled')
      expect(await authorizeEmailViewerSession(dbA, siteId, accepted.value.cookie, secret)).toBe(false);
    expect((await dbA.executor.selectFrom('public_site_email_invitations').select(['state', 'state_reason'])
      .where('id', '=', invitationId).executeTakeFirstOrThrow())).toMatchObject({ state: 'revoked', state_reason: 'mode_changed' });
    expect((await dbA.executor.selectFrom('public_site_invitation_deliveries').select('state')
      .where('invitation_id', '=', invitationId).executeTakeFirstOrThrow()).state).toBe('cancelled');
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id')
      .where('site_id', '=', siteId).where('revoked_at', 'is', null).execute()).toHaveLength(0);
    expect(await dbA.executor.selectFrom('public_site_access_audit_events').select('id')
      .where('site_id', '=', siteId).where('event_type', '=', 'mode_changed').execute()).toHaveLength(1);
    await service.patch(owner, { accessMode: 'private_email', baseRevision: 2 });
    await expect(acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('revokes email authority on unpublish and does not restore old grants on rollback', async () => {
    const { siteId, invitationId } = await seed('unpublish@example.com');
    const versionId = randomUUID(), now = new Date();
    await dbA.executor.insertInto('public_site_versions').values({ id: versionId, site_id: siteId,
      created_at: now.toISOString(), config: { data: {}, forms: [] }, files: [] }).execute();
    await dbA.executor.updateTable('public_sites').set({ active_version: versionId })
      .where('id', '=', siteId).execute();
    const identity = { clerkUserId: 'user_unpublish', clerkSessionId: 'sess_unpublish',
      verifiedEmails: ['unpublish@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    await service.unpublish(owner, 1);
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
    expect((await dbA.executor.selectFrom('public_site_email_invitations').select(['state', 'state_reason'])
      .where('id', '=', invitationId).executeTakeFirstOrThrow())).toMatchObject({ state: 'revoked', state_reason: 'unpublished' });
    expect(await dbA.executor.selectFrom('public_site_access_audit_events').select('id')
      .where('site_id', '=', siteId).where('event_type', '=', 'unpublished').execute()).toHaveLength(1);
    await service.rollback(owner, versionId, 2);
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
    await expect(acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('serializes owner invitation creation against unpublish using the targeted site revision', async () => {
    const { siteId } = await seed('existing-unpublish@example.com');
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    const [created, unpublished] = await Promise.allSettled([
      createSiteEmailInvitations(dbA, owner, { baseRevision: 1,
        emailAddresses: ['new-unpublish@example.com'] }),
      service.unpublish(owner, 1),
    ]);
    expect([created.status, unpublished.status].filter(status => status === 'fulfilled')).toHaveLength(1);
    if (created.status === 'fulfilled') {
      expect(unpublished.status).toBe('rejected');
      await service.unpublish(owner, 2);
    }
    expect((await dbA.executor.selectFrom('public_sites').select('status')
      .where('id', '=', siteId).executeTakeFirstOrThrow()).status).toBe('unpublished');
    expect(await dbA.executor.selectFrom('public_site_email_invitations').select('id')
      .where('site_id', '=', siteId).where('state', 'in', ['pending', 'accepted']).execute()).toHaveLength(0);
    expect(await dbA.executor.selectFrom('public_site_invitation_deliveries').select('id')
      .where('invitation_id', 'in', dbA.executor.selectFrom('public_site_email_invitations')
        .select('id').where('site_id', '=', siteId))
      .where('state', 'in', ['queued', 'leased', 'failed', 'ambiguous']).execute()).toHaveLength(0);
  });

  it('serializes owner revocation against mode change without restoring viewer authority', async () => {
    const { siteId, invitationId } = await seed('revoke-mode-race@example.com');
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const identity = { clerkUserId: 'user_revoke_mode', clerkSessionId: 'sess_revoke_mode',
      verifiedEmails: ['revoke-mode-race@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    const [revoked, changed] = await Promise.allSettled([
      revokeSiteEmailInvitation(dbA, owner, invitationId, { baseRevision: 1, invitationRevision: 1 }),
      service.patch(owner, { accessMode: 'public', baseRevision: 1 }),
    ]);
    expect([revoked.status, changed.status].filter(status => status === 'fulfilled')).toHaveLength(1);
    if (revoked.status === 'fulfilled') await service.patch(owner, { accessMode: 'public', baseRevision: 2 });
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
    expect((await dbA.executor.selectFrom('public_site_email_invitations').select('state')
      .where('id', '=', invitationId).executeTakeFirstOrThrow()).state).toBe('revoked');
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id')
      .where('site_id', '=', siteId).where('revoked_at', 'is', null).execute()).toHaveLength(0);
  });

  it('preserves active email grants across friendly rename and version rollback on the same site', async () => {
    const { siteId } = await seed('rename@example.com');
    const older = randomUUID(), newer = randomUUID();
    const now = new Date().toISOString();
    for (const versionId of [older, newer]) await dbA.executor.insertInto('public_site_versions').values({
      id: versionId, site_id: siteId, created_at: now, config: { data: {}, forms: [] }, files: [],
    }).execute();
    await dbA.executor.updateTable('public_sites').set({ active_version: newer })
      .where('id', '=', siteId).execute();
    const identity = { clerkUserId: 'user_rename', clerkSessionId: 'sess_rename',
      verifiedEmails: ['rename@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    await service.patch(owner, { slug: `email-${siteId.slice(0, 8)}`, title: 'Renamed email app', baseRevision: 1 });
    expect((await service.resolve(`email-${siteId.slice(0, 8)}`))?.id).toBe(siteId);
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(true);
    const rolled = await service.rollback(owner, older, 2);
    expect(rolled.activeVersion).toBe(older);
    expect(rolled.accessMode).toBe('private_email');
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(true);
  });

  it('revokes email authority when a newly deployed version switches publication to public', async () => {
    const { siteId } = await seed('deploy-mode@example.com');
    const identity = { clerkUserId: 'user_deploy_mode', clerkSessionId: 'sess_deploy_mode',
      verifiedEmails: ['deploy-mode@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret, storage: { async putObject() { return {}; },
        async getObject() { return { body: null }; } } });
    const published = await service.deploy(owner, { title: 'Updated public app', accessMode: 'public',
      baseRevision: 1, config: { data: {}, forms: [] }, files: [{ path: 'index.html',
        contentType: 'text/html', body: Buffer.from('<html>Public version</html>').toString('base64') }] });
    expect(published.id).toBe(siteId);
    expect(published.accessMode).toBe('public');
    expect(await authorizeEmailViewerSession(dbA, siteId, issued.cookie, secret)).toBe(false);
    expect(await dbA.executor.selectFrom('public_site_viewer_grants').select('id')
      .where('site_id', '=', siteId).where('revoked_at', 'is', null).execute()).toHaveLength(0);
  });

  it('revokes more than one bounded invitation page during a mode transition', async () => {
    const { siteId } = await seed('bulk-existing@example.com');
    const owner = { ownerId: 'user_site_owner', machineId: 'owner-machine', appSlug: `app-${siteId}` };
    await createSiteEmailInvitations(dbA, owner, { baseRevision: 1,
      emailAddresses: Array.from({ length: 100 }, (_, index) => `bulk-${index}@example.com`) });
    await createSiteEmailInvitations(dbA, owner, { baseRevision: 2,
      emailAddresses: Array.from({ length: 5 }, (_, index) => `extra-${index}@example.com`) });
    const service = createSitesService({ db: dbB, emailCapability: async () => true,
      emailSessionSecret: secret });
    await service.patch(owner, { accessMode: 'public', baseRevision: 3 });
    expect(await dbB.executor.selectFrom('public_site_email_invitations').select('id')
      .where('site_id', '=', siteId).where('state', 'in', ['pending', 'accepted']).execute()).toHaveLength(0);
    expect(await dbB.executor.selectFrom('public_site_email_invitations').select('id')
      .where('site_id', '=', siteId).execute()).toHaveLength(106);
  });

  it('authorizes only an active site-scoped viewer session and denies the next request after grant revocation', async () => {
    const { siteId } = await seed('viewer@example.com');
    const identity = { ...recipient, clerkSessionId: 'sess_viewer', verifiedEmails: ['viewer@example.com'] };
    const issued = await acceptSiteEmailInvitation({ db: dbA, siteId, identity, secret });
    expect(await authorizeEmailViewerSession(dbB, siteId, issued.cookie, secret)).toBe(true);
    expect(await authorizeEmailViewerSession(dbB, randomUUID(), issued.cookie, secret)).toBe(false);
    await dbA.executor.updateTable('public_site_viewer_grants').set({ revoked_at: new Date(), revocation_reason: 'owner' }).where('id', '=', issued.grantId).execute();
    expect(await authorizeEmailViewerSession(dbB, siteId, issued.cookie, secret)).toBe(false);
  });

  it('keeps deletion job and recipient state aligned in both schedule/cancel lock orderings', async () => {
    let sequence = 0;
    const project = (db: PlatformDB, userId: string, state: 'active' | 'inactive') =>
      (transaction: Transaction<PlatformDatabase>) => recordSiteRecipientLifecycle(
        wrapPlatformDb(db.kysely, transaction, Promise.resolve(), async () => undefined, true),
        { userId, state, eventId: `matrix_deletion_race_${++sequence}`,
          eventAt: new Date(Date.now() + sequence * 1000), secret });
    const waitBlocked = async (name: string) => vi.waitFor(async () => {
      const result = await admin.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'`, [name]);
      expect(result.rows[0]?.waiting).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 25 });
    const makeJob = async (owner: string, first: PlatformDB, hold?: () => Promise<void>) => {
      const repository = new AccountDeletionRepository(first.kysely, { secret });
      await repository.acceptPrepared(owner, false, async () => ({ clerkUserId: owner, appleTokens: [] }),
        async transaction => {
          await transaction.updateTable('account_deletion_jobs').set({ billing_stopped: true })
            .where('owner_hash', '=', repository.ownerHash(owner)).execute();
          await project(first, owner, 'inactive')(transaction);
          await hold?.();
        });
      return repository;
    };
    const firstOwner = `user_deletion_race_${randomUUID().replaceAll('-', '')}`;
    const scheduled = Promise.withResolvers<void>(), releaseSchedule = Promise.withResolvers<void>();
    const firstSchedule = makeJob(firstOwner, dbA, async () => {
      scheduled.resolve(); await releaseSchedule.promise;
    });
    await scheduled.promise;
    const firstCancel = new AccountDeletionRepository(dbB.kysely, { secret }).cancel(firstOwner,
      project(dbB, firstOwner, 'active'));
    await waitBlocked('email-accept-b');
    releaseSchedule.resolve();
    await firstSchedule;
    await firstCancel;
    expect((await new AccountDeletionRepository(dbA.kysely, { secret }).get(firstOwner))?.status).toBe('cancelled');
    expect((await dbA.executor.selectFrom('public_site_recipient_lifecycle').select('state')
      .where('recipient_key', '=', siteRecipientKey(firstOwner, secret)).executeTakeFirst())?.state).toBe('active');

    const secondOwner = `user_deletion_race_${randomUUID().replaceAll('-', '')}`;
    await makeJob(secondOwner, dbA);
    const cancelling = Promise.withResolvers<void>(), releaseCancel = Promise.withResolvers<void>();
    const secondCancel = new AccountDeletionRepository(dbB.kysely, { secret }).cancel(secondOwner,
      async transaction => {
        await project(dbB, secondOwner, 'active')(transaction);
        cancelling.resolve(); await releaseCancel.promise;
      });
    await cancelling.promise;
    const secondSchedule = makeJob(secondOwner, dbA);
    await waitBlocked('email-accept-a');
    releaseCancel.resolve();
    await secondCancel;
    await secondSchedule;
    expect((await new AccountDeletionRepository(dbA.kysely, { secret }).get(secondOwner))?.status).toBe('scheduled');
    expect((await dbB.executor.selectFrom('public_site_recipient_lifecycle').select('state')
      .where('recipient_key', '=', siteRecipientKey(secondOwner, secret)).executeTakeFirst())?.state).toBe('inactive');
  }, 20_000);
});
