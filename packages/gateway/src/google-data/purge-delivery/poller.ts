import type { BotIntegrationTransport } from '../../bots/integration-client.js';
import { createGooglePurgeDeliveryClient,GooglePurgeDeliveryError } from './client.js';
import { GooglePurgeReceiptSchema,PurgeOwnerSchema,type GooglePurgeCommand } from './contracts.js';
export type GoogleLocalPurgeCommand=Pick<GooglePurgeCommand,'commandId'|'revision'|'ownerId'|'googleAccountId'|'consentId'|'originId'>;
/** One cycle, at most20 fixed-owner commands. A pending/unresolved receipt never becomes an ACK.
 * Host installs only on an explicitly selected pilot and closes before local storage/runtime teardown. */
export function createGooglePurgeDeliveryPoller(options:{ownerId:string;transport:BotIntegrationTransport;
 purgeAccount(command:GoogleLocalPurgeCommand,signal:AbortSignal):Promise<unknown>;lifetime?:AbortSignal;intervalMs?:number}){
 const ownerId=PurgeOwnerSchema.parse(options.ownerId);const interval=options.intervalMs??30000;
 if(!Number.isInteger(interval)||interval<1000||interval>300000)throw new GooglePurgeDeliveryError();
 const client=createGooglePurgeDeliveryClient(options.transport);const lifetime=new AbortController();
 let timer:ReturnType<typeof setInterval>|undefined;let active:Promise<void>|undefined;let closed=false;let closing:Promise<void>|undefined;
 const runOnce=():Promise<void>=>{
  if(closed)return Promise.reject(new GooglePurgeDeliveryError());if(active)return active;
  const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(60000),...(options.lifetime?[options.lifetime]:[])]);
  active=(async()=>{
   signal.throwIfAborted();const commands=await client.poll(ownerId,signal);
   for(const command of commands){
    signal.throwIfAborted();if(Date.parse(command.leaseUntil)<=Date.now())continue;
    try{
     const {commandId,revision,ownerId:owner,googleAccountId,consentId,originId}=command;
     const result=await options.purgeAccount({commandId,revision,ownerId:owner,googleAccountId,consentId,originId},signal);
     signal.throwIfAborted();const receipt=GooglePurgeReceiptSchema.safeParse(result);
     if(receipt.success)await client.ack(ownerId,{commandId,revision,leaseToken:command.leaseToken,receipt:receipt.data},signal);
    }catch(error:unknown){signal.throwIfAborted();console.warn('[google-purge-delivery] Command incomplete',{category:error instanceof Error?'operation_failed':'untyped_failure'});}
   }
  })().finally(()=>{active=undefined;});return active;
 };
 const tick=()=>{void runOnce().catch((error:unknown)=>console.warn('[google-purge-delivery] Cycle unavailable',{category:error instanceof Error?'operation_failed':'untyped_failure'}));};
 return{
  runOnce,
  start(){if(closed)throw new GooglePurgeDeliveryError();if(timer)return;timer=setInterval(tick,interval);timer.unref?.();tick();},
  close(){if(!closing){closed=true;lifetime.abort();if(timer)clearInterval(timer);timer=undefined;closing=(async()=>{try{await active;}catch(error){console.warn('[google-purge-delivery] Stopped incomplete cycle',{category:error instanceof Error?'operation_failed':'untyped_failure'});}finally{await client.close();}})();}return closing;},
 };
}
