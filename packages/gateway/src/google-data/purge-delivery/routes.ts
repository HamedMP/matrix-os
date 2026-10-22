import { Hono,type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GooglePurgeAckSchema,GooglePurgeCommandsSchema,GooglePurgePollSchema } from './contracts.js';
import type { createGooglePurgeDeliveryStore } from './store.js';
export function createGooglePurgeDeliveryRoutes(options:{store:Pick<ReturnType<typeof createGooglePurgeDeliveryStore>,'poll'|'ack'>;
 resolveRuntime(c:Context):Promise<{ownerId:string;machineId:string}|null>}) {
 const app=new Hono();const limit=bodyLimit({maxSize:65536,onError:c=>c.json({error:'invalid_request'},413)});
 for(const action of ['purge-commands','purge-ack'] as const)app.post(`/gmail/processing/${action}`,limit,async c=>{
  try{
   const principal=await options.resolveRuntime(c);if(!principal)return c.json({error:'unauthorized'},401);
   let raw:unknown;try{raw=await c.req.json();}catch(error){if(error instanceof SyntaxError)return c.json({error:'invalid_request'},400);throw error;}
   if(action==='purge-commands'){
    if(!GooglePurgePollSchema.safeParse(raw).success)return c.json({error:'invalid_request'},400);
    return c.json(GooglePurgeCommandsSchema.parse({commands:await options.store.poll(principal.ownerId,principal.machineId)}));
   }
   const parsed=GooglePurgeAckSchema.safeParse(raw);if(!parsed.success)return c.json({error:'invalid_request'},400);
   await options.store.ack(principal.ownerId,principal.machineId,parsed.data);return c.json({acknowledged:true});
  }catch(error){if(error instanceof Error&&error.name==='BodyLimitError')return c.json({error:'invalid_request'},413);console.warn('[google-purge-delivery] Request unavailable',{category:error instanceof Error?'operation_failed':'untyped_failure'});return c.json({error:'unavailable'},503);}
 });return app;
}
