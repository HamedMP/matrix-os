import { describe, expect, it } from "vitest";
import { normalizeWorkersAiResponse } from "../../packages/proxy/src/funded-relay-workers-response.js";
const model="@cf/google/gemma-4-26b-a4b-it";
const responseModel=`${model}-external`;
const usage={prompt_tokens:20,completion_tokens:16,total_tokens:36,prompt_tokens_details:{cached_tokens:0}};

describe("exact reviewed Workers response aliases",()=>{
 it("canonicalizes the observed Gemma internal alias in a bounded JSON response",async()=>{
  const response=normalizeWorkersAiResponse(Response.json({id:"test",model:responseModel,choices:[{index:0,finish_reason:"stop"}],usage}),model,65536);
  expect((await response.json()).model).toBe(model);
 });
 it("canonicalizes streamed model fields while preserving only final aggregate usage",async()=>{
  const event={id:"test",model:responseModel,choices:[{index:0,delta:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:0,completion_tokens:1,total_tokens:1}};
  const raw=`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({response:"",usage})}\n\ndata: [DONE]\n\n`;
  const response=normalizeWorkersAiResponse(new Response(raw,{headers:{'content-type':'text/event-stream'}}),model,65536);
  const text=await response.text();expect(text).not.toContain(responseModel);expect(text).toContain(`"model":"${model}"`);
  expect(text).toContain('"total_tokens":36');expect(text).not.toContain('"total_tokens":1');
 });
 it("rejects a peer model and arbitrary external suffixes",async()=>{
  for(const actual of ['@cf/zai-org/glm-5.3-flash',`${responseModel}-unreviewed`]){
   const response=normalizeWorkersAiResponse(Response.json({id:'test',model:actual,choices:[],usage}),model,65536);
   await expect(response.text()).rejects.toThrow();
  }
 });
});
