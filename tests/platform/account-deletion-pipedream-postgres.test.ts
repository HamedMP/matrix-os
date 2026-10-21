import { createHmac, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformDb } from '../../packages/platform/src/db.js';
import { createPlatformDb as createGatewayDb } from '../../packages/gateway/src/platform-db.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createAccountDeletionIntegrationWebhookAdmission } from '../../packages/platform/src/account-deletion/integration-webhook.js';

const connectionString=process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)('verified integration admission lock on PostgreSQL',()=>{
  it('drains a verified callback write before deletion acceptance can begin',async()=>{
    const schema=`deletion_webhook_${randomUUID().replaceAll('-','')}`;
    const admin=new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString,max:1})})});
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const db=createPlatformDb({dialect:new PostgresDialect({pool:new Pool({connectionString,max:3,application_name:schema,options:`-c search_path=${schema},public`})})});
    const gatewayDb=createGatewayDb({dialect:new PostgresDialect({pool:new Pool({connectionString,max:2,options:`-c search_path=${schema},public`})})});
    let release!:()=>void;let entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{entered=resolve;});
    try{
      await db.ready;await gatewayDb.migrate();
      const user=await gatewayDb.createUser({clerkId:'user_callbackrace',handle:'callbackrace',displayName:'Owner',email:'owner@example.test',
        containerId:'owner',pipedreamExternalId:'pd_race'});
      const original=gatewayDb.connectService.bind(gatewayDb);
      vi.spyOn(gatewayDb,'connectService').mockImplementation(async input=>{entered();await gate;return original(input);});
      const secret='callback-race-deletion-secret-at-least32';const webhookSecret='provider-signing-secret';
      const pipedream={listAccounts:vi.fn(async()=>[{id:'account_race'}]),revokeAccount:vi.fn(),getAppInfo:vi.fn(async()=>null)} as unknown as PipedreamConnectClient;
      const app=createIntegrationRoutes({db:gatewayDb,pipedream,webhookSecret,resolveUserId:async()=>user.id,
        verifiedConnectedWebhook:createAccountDeletionIntegrationWebhookAdmission({db,pipedream,env:{ACCOUNT_DELETION_SECRET:secret}})});
      const body=JSON.stringify({external_user_id:'pd_race',account_id:'account_race',app:'gmail',email:'owner@example.test'});
      const callback=app.request('/webhook/connected',{method:'POST',body,headers:{'x-pd-signature':createHmac('sha256',webhookSecret).update(body).digest('hex')}});
      await started;
      const scheduling=new AccountDeletionRepository(db.kysely,{secret}).accept({clerkUserId:'user_callbackrace',appleTokens:[]},false);
      try{
        let waiting=false;
        for(let attempt=0;attempt<100;attempt++){
          const result=await sql<{waiting:boolean}>`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=${schema}) AS waiting`.execute(admin);
          if(result.rows[0]!.waiting){waiting=true;break;}
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        expect(waiting).toBe(true);
      }finally{release();}
      expect((await callback).status).toBe(200);await scheduling;
      expect(await gatewayDb.listConnectedServices(user.id)).toHaveLength(1);
      expect((await db.executor.selectFrom('account_deletion_jobs').select('status').executeTakeFirstOrThrow()).status).toBe('scheduled');
    }finally{
      release();await gatewayDb.destroy();await db.destroy();await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);await admin.destroy();
    }
  },20_000);
});
