import { describe, expect, it } from "vitest";
import { FundedAiRouteReadinessReceiptSchema } from "@matrix-os/contracts";
import { serializeFundedOpenAiRequest, workersAiTarget } from "../../packages/proxy/src/funded-relay-openai-request.js";
import { mapFundedModel, estimateWorstCaseMicrousd, priceActualUsageMicrousd } from "../../packages/proxy/src/funded-relay-model.js";
import { readFundedPricingReviews } from "../../packages/proxy/src/funded-pricing-review.js";

const additions = [
 {id:"@cf/deepseek-ai/deepseek-v4-flash-0731",prefix:"DEEPSEEK_FLASH",version:"cloudflare-2026-10-15-deepseek-v4-flash-0731",price:1762},
 {id:"@cf/zai-org/glm-5.3",prefix:"GLM_FULL",version:"cloudflare-2026-10-15-glm-5.3",price:5826},
 {id:"@cf/moonshotai/kimi-k2.7-code",prefix:"KIMI_CODE",version:"cloudflare-2026-10-15-kimi-k2.7-code",price:4969},
 {id:"@cf/openai/gpt-oss-120b",prefix:"GPT_OSS_120B",version:"cloudflare-2026-10-15-gpt-oss-120b",price:1135},
 {id:"@cf/google/gemma-4-26b-a4b-it",prefix:"GEMMA_4",version:"cloudflare-2026-10-15-gemma-4-26b",price:405},
 {id:"@cf/deepseek-ai/deepseek-v4-pro-0813",prefix:"DEEPSEEK_PRO",version:"cloudflare-2026-10-15-deepseek-v4-pro-0813",price:5285},
 {id:"@cf/qwen/qwen3.8-27b",prefix:"QWEN_38",version:"cloudflare-2026-10-15-qwen3.8-27b",price:3655},
 {id:"@cf/openai/gpt-oss-20b",prefix:"GPT_OSS_20B",version:"cloudflare-2026-10-15-gpt-oss-20b",price:520},
];
const gateway="https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/test/anthropic";
const now=new Date("2026-10-15T12:00:00.000Z");
const messages=[{role:"user",content:"hi"}];

describe("reviewed Workers AI additions",()=>{
 it.each(additions)("routes and prices $id with its own expiring review",({id,prefix,version,price})=>{
  expect(mapFundedModel(id)).toEqual({nativeModelId:id,canonicalModelId:id});
  const body=JSON.parse(serializeFundedOpenAiRequest({model:id,messages,max_tokens:128,stream:true}).body);
  expect(body).toMatchObject({model:id,store:false,stream_options:{include_usage:true}});
  expect(workersAiTarget(gateway,id).url).toBe(`https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/${id}`);
  const reviews=readFundedPricingReviews({[`MATRIX_FUNDED_${prefix}_PRICING_REVIEW_VERSION`]:version,[`MATRIX_FUNDED_${prefix}_PRICING_REVIEWED_AT`]:'2026-10-15T00:00:00.000Z',[`MATRIX_FUNDED_${prefix}_PRICING_VALID_THROUGH`]:'2026-10-16T00:00:00.000Z'});
  expect(estimateWorstCaseMicrousd({canonicalModelId:id,inputTokens:100,maxOutputTokens:100,now,pricingReviews:reviews})).toMatchObject({pricingVersion:version});
  expect(()=>estimateWorstCaseMicrousd({canonicalModelId:id,inputTokens:100,maxOutputTokens:100,now})).toThrow(/expired/);
  expect(priceActualUsageMicrousd({canonicalModelId:id,pricingVersion:version,usage:{inputTokens:1000,outputTokens:1000,cacheReadTokens:100,cacheWrite5mTokens:0,cacheWrite1hTokens:0}})).toBe(price);
 });
 it.each(['@cf/deepseek-ai/deepseek-v4-flash-0731','@cf/deepseek-ai/deepseek-v4-pro-0813'])("permits explicit none reasoning for %s",model=>{
  expect(JSON.parse(serializeFundedOpenAiRequest({model,messages,reasoning_effort:'none'}).body).reasoning_effort).toBe('none');
 });
 it("uses Qwen's supported output bound for both input aliases",()=>{
  for(const bound of ['max_tokens','max_completion_tokens']){
   const body=JSON.parse(serializeFundedOpenAiRequest({model:'@cf/qwen/qwen3.8-27b',messages,[bound]:128}).body);
   expect(body.max_completion_tokens).toBe(128);expect(body.max_tokens).toBeUndefined();
  }
 });
 it("validates effort against the selected model rather than a global enum",()=>{
  expect(()=>serializeFundedOpenAiRequest({model:'@cf/zai-org/glm-5.3',messages,reasoning_effort:'none'})).toThrow();
  expect(()=>serializeFundedOpenAiRequest({model:'@cf/openai/gpt-oss-120b',messages,reasoning_effort:'max'})).toThrow();
  expect(()=>serializeFundedOpenAiRequest({model:'@cf/moonshotai/kimi-k2.7-code',messages,reasoning_effort:'low'})).toThrow();
  expect(JSON.parse(serializeFundedOpenAiRequest({model:'@cf/openai/gpt-oss-20b',messages,reasoning_effort:'medium'}).body).reasoning_effort).toBe('medium');
 });
 it("rejects unreviewed models before target construction",()=>{
  expect(()=>workersAiTarget(gateway,'@cf/unreviewed/model')).toThrow();
 });
 it("supports a bounded eight-model review bundle without renewing existing Flash implicitly",()=>{
  const env={MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION:'cloudflare-2026-10-15-workers-eight',MATRIX_FUNDED_WORKERS_PRICING_REVIEWED_AT:'2026-10-15T00:00:00.000Z',MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH:'2026-10-16T00:00:00.000Z'};
  const reviews=readFundedPricingReviews(env);expect(reviews).toHaveLength(8);
  expect(reviews.map(r=>r.canonicalModelId).sort()).toEqual(additions.map(m=>m.id).sort());
  expect(()=>readFundedPricingReviews({...env,MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION:'other'})).toThrow();
  expect(()=>readFundedPricingReviews({...env,MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH:'2026-12-01T00:00:00.000Z'})).toThrow();
  expect(()=>readFundedPricingReviews({MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION:env.MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION})).toThrow();
  expect(()=>readFundedPricingReviews({...env,MATRIX_FUNDED_GLM_FULL_PRICING_REVIEW_VERSION:additions[1]!.version,MATRIX_FUNDED_GLM_FULL_PRICING_REVIEWED_AT:env.MATRIX_FUNDED_WORKERS_PRICING_REVIEWED_AT,MATRIX_FUNDED_GLM_FULL_PRICING_VALID_THROUGH:env.MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH})).toThrow();
 });
 it("bounds ten distinct fresh readiness IDs without extending evidence lifetime",()=>{
  const receipt={contractVersion:1,globalRevision:1,runtimeRevision:1,checkedAt:now.toISOString(),staleAfter:'2026-10-15T12:00:30.000Z',readyModelIds:['anthropic/claude-sonnet-5','@cf/zai-org/glm-5.3-flash',...additions.map(m=>m.id)]};
  expect(FundedAiRouteReadinessReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(FundedAiRouteReadinessReceiptSchema.safeParse({...receipt,staleAfter:'2026-10-15T12:00:31.000Z'}).success).toBe(false);
  expect(FundedAiRouteReadinessReceiptSchema.safeParse({...receipt,readyModelIds:[...receipt.readyModelIds,receipt.readyModelIds[0]]}).success).toBe(false);
 });
});
