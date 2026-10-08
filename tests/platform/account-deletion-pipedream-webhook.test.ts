import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb } from './platform-db-test-helper.js';
import { createPlatformDb as createGatewayDb } from '../../packages/gateway/src/platform-db.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createAccountDeletionIntegrationWebhookAdmission } from '../../packages/platform/src/account-deletion/integration-webhook.js';
import { createApp } from '../../packages/platform/src/main.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const secret='pipedream-deletion-secret-at-least-32';
const webhookSecret='verified-provider-signing-secret';
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const {db,instance}=await createTestPlatformDb();
  const gatewayDb=createGatewayDb({dialect:instance.dialect});
  await gatewayDb.migrate();
  const user=await gatewayDb.createUser({clerkId:'user_webhook',handle:'webhookowner',displayName:'Owner',email:'owner@example.test',
    containerId:'owner',pipedreamExternalId:'pd_owner'});
  const listAccounts=vi.fn(async()=>[{id:'pd_account'}]);
  const revokeAccount=vi.fn(async()=>undefined);
  const pipedream={listAccounts,revokeAccount,getAppInfo:vi.fn(async()=>null),proxyGet:vi.fn()} as unknown as PipedreamConnectClient;
  const admission=createAccountDeletionIntegrationWebhookAdmission({db,env:{ACCOUNT_DELETION_SECRET:secret},pipedream});
  const routes=createIntegrationRoutes({db:gatewayDb,pipedream,webhookSecret,resolveUserId:async()=>user.id,verifiedConnectedWebhook:admission});
  const app=createApp({db,env:{ACCOUNT_DELETION_SECRET:secret},orchestrator:stubOrchestrator(),integrationRoutes:routes});
  async function callback(signature?:string) {
    const body=JSON.stringify({external_user_id:'pd_owner',account_id:'pd_account',app:'gmail',email:'owner@example.test'});
    return app.request('/api/integrations/webhook/connected',{method:'POST',body,headers:{host:'app.matrix-os.com','x-pd-signature':signature??createHmac('sha256',webhookSecret).update(body).digest('hex')}});
  }
  const schedule=()=>new AccountDeletionRepository(db.kysely,{secret}).accept({clerkUserId:'user_webhook',appleTokens:[]},false);
  return {db,gatewayDb,user,listAccounts,revokeAccount,callback,schedule};
}

describe('verified Pipedream callbacks during account deletion',()=>{
  it('revokes a late OAuth completion after the integration checkpoint without resurrecting its projection',async()=>{
    const f=await fixture();
    try{
      await f.gatewayDb.connectService({userId:f.user.id,service:'gmail',pipedreamAccountId:'pd_account',accountLabel:'original',scopes:[]});
      await sql`UPDATE connected_services SET status='revoked'`.execute(f.db.executor);
      await f.schedule();
      expect((await f.callback()).status).toBe(200);
      expect(f.listAccounts).toHaveBeenCalledWith('pd_owner');
      expect(f.revokeAccount).toHaveBeenCalledExactlyOnceWith('pd_account');
      expect((await sql`SELECT status FROM connected_services WHERE user_id=${f.user.id}`.execute(f.db.executor)).rows)
        .toEqual([{status:'revoked'}]);
    }finally{await f.db.destroy();}
  });
  it('revokes an orphan grant after the platform owner has been erased',async()=>{
    const f=await fixture();
    try{
      await f.schedule();
      await sql`DELETE FROM users WHERE id=${f.user.id}`.execute(f.db.executor);
      expect((await f.callback()).status).toBe(200);
      expect(f.revokeAccount).toHaveBeenCalledExactlyOnceWith('pd_account');
    }finally{await f.db.destroy();}
  });
  it('rejects invalid signatures before invoking owner admission or provider cleanup',async()=>{
    const f=await fixture();
    try{
      expect((await f.callback('invalid')).status).toBe(401);
      expect(f.listAccounts).not.toHaveBeenCalled();
      expect(f.revokeAccount).not.toHaveBeenCalled();
    }finally{await f.db.destroy();}
  });
  it('requires scoped provider evidence and provider success before acknowledging blocked callbacks',async()=>{
    const f=await fixture();
    try{
      await f.schedule();
      f.listAccounts.mockResolvedValueOnce([{id:'foreign_account'}]);
      expect((await f.callback()).status).toBe(503);
      expect(f.revokeAccount).not.toHaveBeenCalled();
      f.revokeAccount.mockRejectedValueOnce(Error('provider unavailable'));
      expect((await f.callback()).status).toBe(503);
      expect((await f.callback()).status).toBe(200);
      expect(await f.gatewayDb.listConnectedServices(f.user.id)).toEqual([]);
    }finally{await f.db.destroy();}
  });
  it('keeps normal verified connection persistence working before deletion',async()=>{
    const f=await fixture();
    try{
      expect((await f.callback()).status).toBe(200);
      expect((await f.gatewayDb.listConnectedServices(f.user.id))[0]).toMatchObject({status:'active',pipedream_account_id:'pd_account'});
      expect(f.revokeAccount).not.toHaveBeenCalled();
    }finally{await f.db.destroy();}
  });
  it('acknowledges a retry once scoped provider inventory proves every grant is gone',async()=>{
    const f=await fixture();
    try{
      await f.schedule();
      f.listAccounts.mockResolvedValue([]);
      expect((await f.callback()).status).toBe(200);
      expect(f.revokeAccount).not.toHaveBeenCalled();
    }finally{await f.db.destroy();}
  });
});
