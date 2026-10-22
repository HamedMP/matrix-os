import { describe,expect,it,vi } from 'vitest';
import { createGooglePurgeDeliveryPoller } from '../../../packages/gateway/src/google-data/purge-delivery/poller.js';
const id='123e4567-e89b-42d3-a456-426614174001';
const command={commandId:id,ownerId:'owner-one',googleAccountId:id,consentId:id,originId:'a'.repeat(64),revision:1,leaseToken:id,leaseUntil:new Date(Date.now()+60000).toISOString()};
const receipt={coverage:'registered-copies-only' as const,complete:true,pending:0,unresolved:0,requestIds:[]};
describe('owner-only purge delivery lifecycle',()=>{
 it.each([true,false])('ACKs only after an actually complete local receipt: %s',async complete=>{
  const calls:string[]=[];const transport=vi.fn(async(_owner,request)=>{calls.push(request.path);return Response.json(request.path.endsWith('purge-commands')?{commands:[command]}:{acknowledged:true});});
  const purge=vi.fn(async()=>{calls.push('local-purge-settled');return{...receipt,complete,pending:complete?0:1};});
  const poller=createGooglePurgeDeliveryPoller({ownerId:'owner-one',transport,purgeAccount:purge});
  await poller.runOnce();await poller.close();
  expect(calls).toEqual(['/gmail/processing/purge-commands','local-purge-settled',...(complete?['/gmail/processing/purge-ack']:[])]);
  expect(purge.mock.calls[0]![0]).not.toHaveProperty('leaseToken');
 });
 it('continues later commands when an earlier cleanup cannot produce a receipt',async()=>{
  const later={...command,commandId:'123e4567-e89b-42d3-a456-426614174002'};
  const transport=vi.fn(async(_owner,request)=>Response.json(request.path.endsWith('purge-commands')?{commands:[command,later]}:{acknowledged:true}));
  const purge=vi.fn(async(current)=>{if(current.commandId===command.commandId)throw Error('private unresolved stop proof');return receipt;});
  const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const poller=createGooglePurgeDeliveryPoller({ownerId:'owner-one',transport,purgeAccount:purge});
  try{await poller.runOnce();expect(purge).toHaveBeenCalledTimes(2);
   expect(transport.mock.calls.filter(([,request])=>request.path.endsWith('purge-ack'))).toHaveLength(1);
   expect(JSON.stringify(log.mock.calls)).not.toContain('private unresolved');
  }finally{await poller.close();log.mockRestore();}
 });
 it('never overlaps cycles and closes only after actual local cancellation settlement',async()=>{
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;const settled=new Promise<void>(resolve=>{release=resolve;});
  const transport=vi.fn(async()=>Response.json({commands:[command]}));let signal:AbortSignal|undefined;
  const poller=createGooglePurgeDeliveryPoller({ownerId:'owner-one',transport,purgeAccount:async(_command,current)=>{signal=current;entered();await settled;return receipt;}});
  const first=poller.runOnce().catch(()=>undefined);await started;const second=poller.runOnce().catch(()=>undefined);expect(transport).toHaveBeenCalledTimes(1);
  let closed=false;const closing=poller.close().then(()=>{closed=true;});await Promise.resolve();expect(signal!.aborted).toBe(true);expect(closed).toBe(false);
  release();await Promise.all([first,second,closing]);expect(transport).toHaveBeenCalledTimes(1);expect(closed).toBe(true);
 });
 it.each(['transport','body'] as const)('drains actual %s and late body cancellation before close resolves',async phase=>{
  let fetchEntered!:()=>void;const entered=new Promise<void>(resolve=>{fetchEntered=resolve;});let resolveFetch!:(response:Response)=>void;
  let cancelEntered!:()=>void;const cancelling=new Promise<void>(resolve=>{cancelEntered=resolve;});let releaseCancel!:()=>void;
  const cancelGate=new Promise<void>(resolve=>{releaseCancel=resolve;});let releasePull!:()=>void;
  const response=new Response(new ReadableStream({pull(){return new Promise<void>(resolve=>{releasePull=resolve;});},async cancel(){cancelEntered();await cancelGate;}}),{headers:{'content-type':'application/json'}});
  const transport=vi.fn(async()=>{fetchEntered();return phase==='transport'?new Promise<Response>(resolve=>{resolveFetch=resolve;}):response;});
  const poller=createGooglePurgeDeliveryPoller({ownerId:'owner-one',transport,purgeAccount:async()=>receipt});
  const running=poller.runOnce().catch(error=>{expect(error).toBeInstanceOf(Error);});await entered;
  let closed=false;const closing=poller.close().then(()=>{closed=true;});
  try{await new Promise(resolve=>setTimeout(resolve,0));expect(closed).toBe(false);
   if(phase==='transport')resolveFetch(response);await cancelling;expect(closed).toBe(false);
  }finally{resolveFetch?.(response);releaseCancel();releasePull?.();await running;await closing;}
 });
 it('does not process expired leases or accept foreign-owner commands',async()=>{
  const purge=vi.fn(async()=>receipt);const transport=vi.fn(async()=>Response.json({commands:[{...command,leaseUntil:new Date(0).toISOString()}]}));
  const poller=createGooglePurgeDeliveryPoller({ownerId:'owner-one',transport,purgeAccount:purge});await poller.runOnce();await poller.close();expect(purge).not.toHaveBeenCalled();
  const foreign=createGooglePurgeDeliveryPoller({ownerId:'owner-two',transport,purgeAccount:purge});await expect(foreign.runOnce()).rejects.toThrow();await foreign.close();
 });
});
