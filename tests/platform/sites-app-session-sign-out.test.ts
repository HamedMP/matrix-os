import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { acceptSiteEmailInvitation, siteClerkSessionKey } from '../../packages/platform/src/sites/email-invitations.js';
import { authorizeEmailViewerSession } from '../../packages/platform/src/sites/email-viewer-sessions.js';

afterEach(() => vi.restoreAllMocks());

it('terminates the shared Clerk session across apps before main Matrix sign-out clears cookies', async () => {
  const {db}=await createTestPlatformDb();
  const secret='sign-out-sites-secret-that-is-long-enough';
  const sessionId='sess_shared_sign_out';
  const sites: Array<{id:string;cookie:string}> = [];
  try {
    await insertUserMachine(db,{machineId:'sign-out-owner-machine',clerkUserId:'user_sign_out_owner',
      handle:'sign-out-owner',status:'running',provisionedAt:new Date().toISOString()});
    for (const index of [1,2]) {
      const id=randomUUID(), invitationId=randomUUID(), now=new Date();
      await db.executor.insertInto('public_sites').values({id,owner_id:'user_sign_out_owner',
        machine_id:'sign-out-owner-machine',app_slug:`sign-out-${index}`,title:'Shared app',description:'',
        slug:null,revision:1,status:'published',access_mode:'private_email',active_version:null,
        created_at:now.toISOString()}).execute();
      await db.executor.insertInto('public_site_email_invitations').values({id:invitationId,site_id:id,
        normalized_email:'viewer@example.com',display_email:'viewer@example.com',generation:'1',
        state:'pending',delivery_state:'queued',invited_by_clerk_user_id:'user_sign_out_owner',
        accepted_clerk_user_id:null,created_at:now,issued_at:now,
        expires_at:new Date(now.getTime()+7*86400_000),accepted_at:null,revoked_at:null,
        state_reason:null,updated_at:now,revision:'0'}).execute();
      const issued=await acceptSiteEmailInvitation({db,siteId:id,identity:{clerkUserId:'user_shared_viewer',
        clerkSessionId:sessionId,verifiedEmails:['viewer@example.com']},secret});
      sites.push({id,cookie:issued.cookie});
      expect(await authorizeEmailViewerSession(db,id,issued.cookie,secret)).toBe(true);
    }
    const revokeSession=vi.fn(async()=>{
      for (const site of sites) expect(await authorizeEmailViewerSession(db,site.id,site.cookie,secret)).toBe(false);
    });
    const app=createApp({db,orchestrator:stubOrchestrator(),env:{ACCOUNT_DELETION_SECRET:secret},
      platformSecret:'site-sign-out-platform-secret-1234567890',
      clerkAuth:createClerkAuth({verifyToken:async()=>({sub:'user_shared_viewer',sid:sessionId}),revokeSession})});
    const response=await app.request('/api/auth/app-session',{method:'DELETE',headers:{host:'app.matrix-os.com',
      cookie:'__session=verified-clerk-token; matrix_app_session=matrix-token'}});
    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(sessionId);
    for (const site of sites) expect(await authorizeEmailViewerSession(db,site.id,site.cookie,secret)).toBe(false);
    const marker=await db.executor.selectFrom('public_site_clerk_session_terminations')
      .select('clerk_session_key').where('clerk_session_key','=',siteClerkSessionKey(sessionId,secret)).executeTakeFirst();
    expect(marker).toBeDefined();
  } finally { await destroyTestPlatformDb(db); }
});

it('does not revoke Clerk or clear cookies if viewer termination cannot commit', async () => {
  const { db } = await createTestPlatformDb();
  try {
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('database unavailable'));
    const revokeSession = vi.fn(async () => undefined);
    const app = createApp({ db, orchestrator: stubOrchestrator(),
      env: { ACCOUNT_DELETION_SECRET: 'sign-out-sites-secret-that-is-long-enough' },
      platformSecret: 'site-sign-out-platform-secret-1234567890',
      clerkAuth: createClerkAuth({ verifyToken: async () => ({ sub: 'user_shared_viewer', sid: 'sess_failed_sign_out' }),
        revokeSession }) });
    const response = await app.request('/api/auth/app-session', { method: 'DELETE',
      headers: { host: 'app.matrix-os.com', cookie: '__session=verified-clerk-token' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Sign-out is temporarily unavailable. Try again.' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(revokeSession).not.toHaveBeenCalled();
  } finally { await destroyTestPlatformDb(db); }
});
