import { describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
import { createGooglePurgeDeliveryRoutes } from '../../../packages/gateway/src/google-data/purge-delivery/routes.js';
import { createGooglePurgeDeliveryClient } from '../../../packages/gateway/src/google-data/purge-delivery/client.js';
const id='123e4567-e89b-42d3-a456-426614174001';
const command={commandId:id,ownerId:'owner-one',googleAccountId:id,consentId:id,originId:'a'.repeat(64),revision:1,leaseToken:id,leaseUntil:new Date(Date.now()+60000).toISOString()};
const receipt={coverage:'registered-copies-only',complete:true,pending:0,unresolved:0,requestIds:[]};
function fixture(){
 const store={poll:vi.fn(async()=>[command]),ack:vi.fn(async()=>undefined)};
 const app=new Hono().route('/',createGooglePurgeDeliveryRoutes({store,resolveRuntime:async c=>c.req.header('x-test-auth')==='verified'?{ownerId:'owner-one',machineId:'machine-one'}:null}));
 return{app,store};
}
describe('internal Google purge delivery',()=>{
 it('rejects public/unsigned owners, caller owner selectors, invalid ACKs and oversized bodies',async()=>{
  const f=fixture(); const post=(body:unknown,auth='verified',path='purge-commands')=>f.app.request(`/gmail/processing/${path}`,{method:'POST',headers:{'content-type':'application/json','x-test-auth':auth},body:JSON.stringify(body)});
  expect((await post({},'public')).status).toBe(401);expect(f.store.poll).not.toHaveBeenCalled();
  expect((await post({ownerId:'other'})).status).toBe(400);
  expect((await post({junk:'x'.repeat(70000)})).status).toBe(413);
  expect((await post({commandId:id,revision:1,leaseToken:id,receipt:{...receipt,complete:false}},'verified','purge-ack')).status).toBe(400);
  expect(f.store.ack).not.toHaveBeenCalled();
 });
 it('uses only fixed internal paths, exact owner commands and complete receipts',async()=>{
  const f=fixture(); const transport=vi.fn(async(_owner,request)=>f.app.request(request.path,{method:request.method,headers:{'content-type':'application/json','x-test-auth':'verified'},body:JSON.stringify(request.body),signal:request.signal}));
  const client=createGooglePurgeDeliveryClient(transport);
  expect(await client.poll('owner-one')).toEqual([command]);expect(f.store.poll).toHaveBeenCalledWith('owner-one','machine-one');
  await client.ack('owner-one',{commandId:id,revision:1,leaseToken:id,receipt});
  expect(transport.mock.calls.map(([,request])=>request.path)).toEqual(['/gmail/processing/purge-commands','/gmail/processing/purge-ack']);
  await expect(client.poll('other-owner')).rejects.toThrow();
 });
 it('discards oversized, foreign and aborted responses without accepting any commands',async()=>{
  const huge=vi.fn(async()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}));
  await expect(createGooglePurgeDeliveryClient(huge).poll('owner-one')).rejects.toThrow();
  const abort=new AbortController();abort.abort();
  await expect(createGooglePurgeDeliveryClient(huge).poll('owner-one',abort.signal)).rejects.toThrow();expect(huge).toHaveBeenCalledTimes(1);
 });
});
