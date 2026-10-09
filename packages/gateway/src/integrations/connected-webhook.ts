import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { PlatformDb } from '../platform-db.js';
import type { PipedreamConnectClient } from './pipedream.js';
import { getServiceByPipedreamApp } from './registry.js';
import type { IntegrationBroadcast } from './routes.js';

export interface VerifiedConnectedWebhook {
  externalUserId:string;
  accountId:string;
  user:{id:string;clerkId:string}|null;
}
export type VerifiedConnectedWebhookAdmission = (input:VerifiedConnectedWebhook,persist:()=>Promise<void>)=>Promise<void>;
const bodySchema=z.object({external_user_id:z.string().min(1).max(256),account_id:z.string().min(1).max(256),
  app:z.string().min(1).max(100),label:z.string().trim().min(1).max(100).optional(),email:z.string().max(320).optional(),
  scopes:z.array(z.string().max(256)).max(100).optional()});

/** Admission receives only authenticated provider payloads; it can discard late grants without writing a projection. */
export function registerConnectedIntegrationWebhook(app:Hono,options:{
  db:PlatformDb;pipedream:PipedreamConnectClient;webhookSecret:string;emit:IntegrationBroadcast;
  verifiedConnectedWebhook?:VerifiedConnectedWebhookAdmission;
  consumePendingLabel(key:string):string|undefined;
  resolveAccountEmail(externalUserId:string,accountId:string,service:string):Promise<string|undefined>;
  applyExplicitReconnectLabel(row:Awaited<ReturnType<PlatformDb['connectService']>>,label:string|undefined):Promise<void>;
}):void {
  app.post('/webhook/connected',bodyLimit({maxSize:65536}),async c=>{
    const raw=await c.req.text();
    const signature=c.req.header('x-pd-signature');
    if(!options.webhookSecret || !signature || !/^[a-fA-F0-9]{64}$/.test(signature)
      || !timingSafeEqual(Buffer.from(signature,'hex'),createHmac('sha256',options.webhookSecret).update(raw).digest())) {
      return c.json({error:'Invalid signature'},401);
    }
    let body:unknown;
    try{body=JSON.parse(raw);}catch(error:unknown){
      console.warn('[integrations] Invalid connected webhook JSON:',error instanceof Error?error.name:typeof error);
      return c.json({error:'Invalid JSON'},400);
    }
    const parsed=bodySchema.safeParse(body);
    if(!parsed.success)return c.json({error:'Invalid webhook payload'},400);
    const {external_user_id,account_id,app:appName,label,email,scopes}=parsed.data;
    const service = getServiceByPipedreamApp(appName);
    if(!service)return c.json({error:'Unsupported app'},400);
    try {
      const user=await options.db.getUserByPipedreamExternalId(external_user_id);
      if(!user && !options.verifiedConnectedWebhook)return c.json({error:'Unknown user'},400);
      const persist=async()=>{
        if(!user)throw Error('Integration owner unavailable');
        const explicitLabel=options.consumePendingLabel(`${external_user_id}:${appName}`);
        const resolvedLabel=explicitLabel??label??service.id;
        const resolvedEmail=email??await options.resolveAccountEmail(external_user_id,account_id,service.id);
        const row=await options.db.connectService({userId:user.id,service:service.id,pipedreamAccountId:account_id,
          accountLabel:resolvedLabel,accountEmail:resolvedEmail,scopes:scopes??[]});
        await options.applyExplicitReconnectLabel(row,explicitLabel);
        if(row.inserted)options.emit({type:'integration:connected',service:service.id,accountLabel:resolvedLabel});
      };
      if(options.verifiedConnectedWebhook)await options.verifiedConnectedWebhook({externalUserId:external_user_id,accountId:account_id,
        user:user?{id:user.id,clerkId:user.clerk_id}:null},persist);
      else await persist();
      return c.json({ok:true});
    }catch(error:unknown){
      console.error('[integrations] connected webhook failed:',error instanceof Error?error.name:typeof error);
      return c.json({error:'Connection unavailable'},options.verifiedConnectedWebhook?503:500);
    }
  });
}
