import {generateKeyPairSync} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {chatGptPlanPeerRequestId} from '@matrix-os/contracts';
import {createPlanNativePeer} from '../../desktop/src/main/chatgpt-plan/peer';
it.each([['chunk', 'ssl'], ['end', 'ssl'], ['chunk', 'http502'], ['end', 'http502']] as const)('negotiated reply %s ACK loss (%s) recovers once without another inference',async(lostKind, failureKind)=>{
 const sessionId='00000000-0000-4000-8000-000000000001',id=chatGptPlanPeerRequestId(sessionId,1);
 const key=generateKeyPairSync('ed25519');const replies:Array<{stream?:string;sequence?:number;ok:boolean;body?:string}>=[];
 let polls=0,lost=false;const accepted:string[]=[];
 const inferStream=vi.fn(async function*(){yield 'data: first\n\n';yield 'data: second\n\n';});
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const peer=createPlanNativePeer({deliveryVersion:2,current:()=>true,connected:()=>{},infer:async()=>{throw new Error('unexpected inference');},inferStream,
 fetchFn:vi.fn(async(url,init)=>{
  const path=new URL(String(url)).pathname.split('/').at(-1);
  if(path==='challenge')return Response.json({version:1,challenge:'a'.repeat(64),ownerId:'owner',computerId:'computer',expiresAt:new Date(Date.now()+60000).toISOString()});
  if(path==='connect')return Response.json({version:1,sessionId});
  if(path==='capabilities')return Response.json({version:1,sessionId,pollDeliveryVersion:2,replyDeliveryVersion:2});
  if(path==='poll-v2'){
   const input=JSON.parse(String(init?.body));if(polls++===0)return Response.json({version:2,sessionId,acknowledgedThrough:0,deliveries:[{deliverySequence:1,request:{version:1,action:'infer',responseMode:'stream',id,sequence:1,expiresAt:new Date(Date.now()+120000).toISOString(),accountId:'account',grantRevision:1,computerId:'computer',requestClass:'interactive',runId:'run',model:'model',body:'{}'}}]});
   if(!init!.signal!.aborted)await new Promise<void>(resolve=>init!.signal!.addEventListener('abort',()=>resolve(),{once:true}));
   return Response.json({version:2,sessionId,acknowledgedThrough:input.ackThrough,deliveries:[]});
  }
  if(path==='reply'){
   const r=JSON.parse(String(init?.body));replies.push(r);
   if(r.stream==='chunk'){
    if(r.sequence===accepted.length)accepted.push(r.body);
   }
   if(r.stream===lostKind&&!lost){lost=true;if(failureKind==='http502')return new Response('',{status:502});throw new Error('net::ERR_SSL_PROTOCOL_ERROR');}
   return Response.json({version:1,ok:true,sessionId,id,sequence:r.sequence});
  }
  if(path==='disconnect')return Response.json({ok:true});throw new Error('unexpected route');
 })as typeof fetch});
 try{
  await peer.start({runtimeSlot:'primary',authGeneration:1,ownerId:'owner',computerId:'computer',origin:'https://matrix.test',bearer:'fixture',privateKey:key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:key.publicKey.export({type:'spki',format:'der'}).toString('base64url')},{deviceId:'a'.repeat(64),accountId:'account',grantRevision:1,enabled:true,background:false,models:[{id:'model',displayName:'Fixture',input:['text'],contextWindow:8192,maxOutputTokens:256}]});
  await vi.waitFor(()=>expect(replies.some(r=>!r.ok)||replies.filter(r=>r.stream===lostKind).length>=2).toBe(true),{timeout:1000});
  expect(inferStream).toHaveBeenCalledOnce();
  expect(replies.filter(r=>r.stream===lostKind&&r.sequence=== (lostKind==='chunk'?0:2))).toHaveLength(2);
  const replayed=replies.filter(r=>r.stream===lostKind&&r.sequence===(lostKind==='chunk'?0:2));expect(replayed[0]).toEqual(replayed[1]);
  expect(accepted.join('')).toBe('data: first\n\ndata: second\n\n');
  expect(replies.some(r=>r.stream==='end')).toBe(true);expect(replies.some(r=>!r.ok)).toBe(false);
 }finally{await peer.stop();warn.mockRestore();}
});
