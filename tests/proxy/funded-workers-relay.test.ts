import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { createFundedRelayService } from "../../packages/proxy/src/funded-main-app.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const models=[
 ['@cf/deepseek-ai/deepseek-v4-flash-0731',1718],['@cf/zai-org/glm-5.3',5686],
 ['@cf/moonshotai/kimi-k2.7-code',4874],['@cf/openai/gpt-oss-120b',1100],
 ['@cf/google/gemma-4-26b-a4b-it',395],['@cf/deepseek-ai/deepseek-v4-pro-0813',5153],
 ['@cf/qwen/qwen3.8-27b',3610],['@cf/openai/gpt-oss-20b',500],
] as const;
const now=new Date('2026-10-15T12:00:00.000Z');
const identity={tokenId:'credential_123',ownerId:'owner_123',machineId:'machine_123',runtimeSlot:'preview',audience:'matrix-funded-relay',scope:'ai:invoke',expiresAt:'2026-10-15T12:15:00.000Z'};
const credential=`sk-matrix-funded-credential_123.${'s'.repeat(43)}`;
function config(){return resolveFundedRelayConfig({
 MATRIX_FUNDED_AI_ENABLED:'true',MATRIX_FUNDED_AI_RESERVATION_MODE:'usage',CLOUDFLARE_AI_GATEWAY_URL:'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/test/anthropic',CLOUDFLARE_AI_GATEWAY_TOKEN:'g'.repeat(32),CLOUDFLARE_WORKERS_AI_TOKEN:'w'.repeat(32),PLATFORM_INTERNAL_URL:'https://platform.example.test',AI_RELAY_CONTROL_TOKEN:'c'.repeat(32),AI_RELAY_METADATA_SECRET:'m'.repeat(32),
 MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION:'cloudflare-2026-10-15-workers-eight',MATRIX_FUNDED_WORKERS_PRICING_REVIEWED_AT:'2026-10-15T00:00:00.000Z',MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH:'2026-10-16T00:00:00.000Z',
})!;}
function upstream(model:string,stream:boolean,missingUsage=false){
 const actual=model==='@cf/google/gemma-4-26b-a4b-it'?`${model}-external`:model;
 const usage={prompt_tokens:1000,completion_tokens:1000,total_tokens:2000,prompt_tokens_details:{cached_tokens:100}};
 const event={id:'response_test',model:actual,choices:[{index:0,message:{role:'assistant',content:'ok'},delta:{content:'ok'},finish_reason:'stop'}]};
 if(!stream)return Response.json({success:true,result:{...event,...(missingUsage?{}:{usage})}});
 return new Response(`data: ${JSON.stringify({...event,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n${missingUsage?'':`data: ${JSON.stringify({response:'',usage})}\n\n`}data: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
}
function platform(){return{
 check:vi.fn(async()=>({identity})),authorize:vi.fn(async(input:{modelId:string,requestId:string})=>({identity,reservation:{reservationId:'reservation_test',requestId:input.requestId,modelId:input.modelId,reservedMicrousd:1,billingMode:'usage'}})),
 start:vi.fn(async()=>({reservationId:'reservation_test',requestId:'request_test',tokenId:identity.tokenId})),release:vi.fn(),finalize:vi.fn(async()=>({})),
};}

describe('all approved Workers models through funded Relay',()=>{
 it.each(models)('uses the exact authenticated prepaid route and settles %s once',async(model,cost)=>{
  for(const stream of [false,true]){
   const control=platform();const fetchFn=vi.fn<typeof fetch>(async()=>upstream(model,stream));
   const relay=createFundedRelay({...config(),now:()=>now,fetch:fetchFn,platformClient:control as unknown as FundedPlatformClient,requestIdFactory:()=> 'request_test'});
   const app=new Hono();relay.register(app);
   try{
    const response=await app.request('/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hello'}],max_tokens:2048,stream})});
    expect(response.status).toBe(200);const body=await response.text();expect(body).toContain(`"model":"${model}"`);expect(body).not.toContain(`${model}-external`);
   }finally{await relay.close();}
   expect(fetchFn).toHaveBeenCalledTimes(1);expect(String(fetchFn.mock.calls[0]![0])).toBe(`https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/${model}`);
   expect(control.authorize).toHaveBeenCalledWith(expect.objectContaining({modelId:model,billingMode:'usage'}),expect.any(AbortSignal));
   expect(control.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({mode:'exact',actualCostMicrousd:cost}),expect.any(AbortSignal));
  }
 });
 it.each(models)('requires a model-specific priced readiness response for %s',async(model)=>{
  const fetchFn=vi.fn<typeof fetch>(async()=>upstream(model,false));const service=createFundedRelayService(config(),{now:()=>now,fetchFn});
  try{
   const response=await service.app.request(`/ready?model=${encodeURIComponent(model)}`,{headers:{authorization:`Bearer ${config().relayControlToken}`}});
   expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ready:true,priceValidThrough:'2026-10-16T00:00:00.000Z'});
   expect(fetchFn).toHaveBeenCalledTimes(1);expect(String(fetchFn.mock.calls[0]![0])).toContain(`/ai/run/${model}`);
  }finally{await service.close();}
 });
 it('leaves missing aggregate usage unresolved for an added model',async()=>{
  const model=models[0][0];const control=platform();const relay=createFundedRelay({...config(),now:()=>now,fetch:async()=>upstream(model,true,true),platformClient:control as unknown as FundedPlatformClient,requestIdFactory:()=> 'request_test'});const app=new Hono();relay.register(app);
  try{const response=await app.request('/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hello'}],max_tokens:2048,stream:true})});await response.text();}finally{await relay.close();}
  expect(control.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({mode:'conservative'}),expect.any(AbortSignal));
 });
});
