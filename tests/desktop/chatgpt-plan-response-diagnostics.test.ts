import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPlanResponse } from '../../desktop/src/main/chatgpt-plan/responses';
import { PlanFailure, logPlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const secret = 'private input token and provider /path';
const body = JSON.stringify({model:'fixture-model',input:[{role:'user',content:'fixture only'}],store:false,stream:true});
async function run(response:Response, signal:AbortSignal=new AbortController().signal) {
 const fetchFn=vi.fn(async()=>response);
 const result=await requestPlanResponse({fetchFn,body,model:'fixture-model',signal,accessToken:async()=> 'fixture-token',validate:()=>{}}).then(value=>value,error=>error);
 expect(fetchFn).toHaveBeenCalledOnce();
 expect(result).toBeInstanceOf(PlanFailure);
 const failure=result as PlanFailure;
 expect(failure).toMatchObject({stage:'responses',category:response.ok?'invalid_stream':'http_error',httpStatus:response.status});
 return failure;
}
describe('bounded unexpected Responses MIME diagnostics',()=>{
 it('records allowlisted JSON structure and provider codes without accepting JSON success or exposing content',async()=>{
  const failure=await run(Response.json({object:'response',status:'failed',error:{code:'insufficient_quota',message:secret},output:secret}));
  expect(failure).toHaveProperty('responseDiagnostic',{mime:'json',bodyRead:'complete',bodyShape:'object',responseType:'response',responseStatus:'failed',errorCode:'insufficient_quota',sseFraming:false,sseCompleted:false,hasDetail:false,hasError:true,responseObject:true});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});logPlanFailure('responses',failure);
  const log=JSON.stringify(warn.mock.calls);expect(log).toContain('insufficient_quota');expect(log).not.toContain(secret);expect(log).not.toContain('fixture-token');
 });
 it('never accepts a completed JSON response and suppresses arbitrary type, status and error codes',async()=>{
  const failure=await run(Response.json({type:secret,status:secret,error:{code:secret,message:secret}}));
  expect(failure).toHaveProperty('responseDiagnostic',{mime:'json',bodyRead:'complete',bodyShape:'object',sseFraming:false,sseCompleted:false,hasDetail:false,hasError:true,responseObject:false});
  const completed=await run(Response.json({object:'response',status:'completed',output:secret}));
  expect(completed).toHaveProperty('responseDiagnostic.responseStatus','completed');
 });
 it('distinguishes a detail admission envelope and keeps only documented subscription codes',async()=>{
  const code='subscription_sharing_route_not_supported';
  const failure=await run(Response.json({detail:secret,code}));
  expect(failure).toHaveProperty('responseDiagnostic',expect.objectContaining({hasDetail:true,hasError:false,responseObject:false,errorCode:code}));
  const legacy=await run(Response.json({detail:{code:'chatpass_v2_scope_not_authorized',message:secret}}));
  expect(legacy).toHaveProperty('responseDiagnostic.errorCode','chatpass_v2_scope_not_authorized');
  expect(JSON.stringify(failure)).not.toContain(secret);expect(JSON.stringify(legacy)).not.toContain(secret);
 });
 it.each([
  ['text/html; charset=utf-8',`<html>${secret}</html>`,'html','non_json'],
  ['text/plain','private plaintext','plain','non_json'],
  ['application/x-private',JSON.stringify([secret]),'other','array'],
  ['application/json','{ broken secret','json','non_json'],
  ['application/json','"private string"','json','string'],
  ['application/json','null','json','null'],
  ['application/json','','json','empty'],
 ])('classifies %s as %s using only bounded shape',async(contentType,text,mime,bodyShape)=>{
  const failure=await run(new Response(text,{headers:{'content-type':contentType}}));
  expect(failure).toHaveProperty('responseDiagnostic',expect.objectContaining({mime,bodyRead:'complete',bodyShape,sseFraming:false,sseCompleted:false}));
  expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('records fixed SSE framing/completion booleans for a failed HTTP stream',async()=>{
  const failure=await run(new Response(`event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"fixture-model","output":"${secret}"}}\n\n`,{status:403,headers:{'content-type':'text/plain'}}));
  expect(failure).toHaveProperty('responseDiagnostic',expect.objectContaining({mime:'plain',bodyShape:'non_json',sseFraming:true,sseCompleted:true}));
  expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('rejects unframed JSON even under a MIME suffix resembling an event stream',async()=>{
  const response=new Response('{"object":"response","status":"completed","model":"fixture-model"}',{headers:{'content-type':'text/event-stream-private'}});
  const failure=await run(response);
  expect(failure).toHaveProperty('responseDiagnostic',expect.objectContaining({mime:'other',sseFraming:false,sseCompleted:false}));
 });
 it('releases the sampled stream lock even when underlying cancellation never settles',async()=>{
  const cancel=vi.fn(()=>new Promise<void>(()=>{}));
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16*1024+1));},cancel});
  const failure=await run(new Response(stream,{status:403,headers:{'content-type':'application/json'}}));
  expect(failure).toHaveProperty('responseDiagnostic.bodyRead','oversize');expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
 });
 it('caps oversized reads and cancels without losing the original HTTP status',async()=>{
  const cancel=vi.fn();const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(secret.repeat(2000)));},cancel});
  const failure=await run(new Response(stream,{status:403,headers:{'content-type':'application/json'}}));
  expect(failure).toHaveProperty('responseDiagnostic.bodyRead','oversize');expect(cancel).toHaveBeenCalledOnce();expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('retains the MIME/status diagnostic on a failed body stream and ignores cancellation failure text',async()=>{
  const stream=new ReadableStream({start(controller){controller.error(new Error(secret));}});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const failure=await run(new Response(stream,{status:403,headers:{'content-type':'application/json'}}));
  expect(failure).toHaveProperty('responseDiagnostic.bodyRead','failed');logPlanFailure('responses',failure);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
 });
 it('stops a hanging diagnostic read when the inference is aborted',async()=>{
  const controller=new AbortController(),cancel=vi.fn();const stream=new ReadableStream({cancel});
  const pending=run(new Response(stream,{status:403,headers:{'content-type':'application/json'}}),controller.signal);
  await Promise.resolve();await Promise.resolve();controller.abort();
  const failure=await pending;expect(failure).toHaveProperty('responseDiagnostic.bodyRead','cancelled');expect(cancel).toHaveBeenCalledOnce();
 });
 it('bounds diagnostic reads independently of a hanging provider stream',async()=>{
  vi.useFakeTimers();const cancel=vi.fn(),stream=new ReadableStream({cancel});
  const pending=run(new Response(stream,{status:403,headers:{'content-type':'application/json'}}));
  await vi.advanceTimersByTimeAsync(1500);const failure=await pending;
  expect(failure).toHaveProperty('responseDiagnostic.bodyRead','timeout');expect(cancel).toHaveBeenCalledOnce();
 });
 it('sanitizes diagnostics again at the logger boundary',()=>{
  const failure=new PlanFailure('responses','invalid_content_type',200);
  Object.assign(failure,{responseDiagnostic:{mime:'json',bodyShape:secret,errorCode:secret,responseType:secret,responseStatus:secret,bodyRead:'complete',sseFraming:secret,sseCompleted:false,extra:secret}});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});logPlanFailure('responses',failure);
  const log=JSON.stringify(warn.mock.calls);expect(log).toContain('json');expect(log).not.toContain(secret);expect(log).not.toContain('extra');
 });
});
