import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPlanResponse } from '../../desktop/src/main/chatgpt-plan/responses';
import { PlanFailure, logPlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const secret = 'private input token and provider /path';
const body = JSON.stringify({model:'fixture-model',input:[{role:'user',content:'fixture only'}],store:false,stream:true});
async function run(response:Response, signal:AbortSignal=new AbortController().signal, category?: string) {
 const fetchFn=vi.fn(async()=>response);
 const result=await requestPlanResponse({fetchFn,body,model:'fixture-model',signal,accessToken:async()=> 'fixture-token',validate:()=>{}}).then(value=>value,error=>error);
 expect(fetchFn).toHaveBeenCalledOnce();
 expect(result).toBeInstanceOf(PlanFailure);
 const failure=result as PlanFailure;
 expect(failure).toMatchObject({stage:'responses',category:category ?? (response.ok?'invalid_stream':'http_error'),httpStatus:response.status});
 return failure;
}
describe('bounded unexpected Responses MIME diagnostics',()=>{
 it('records allowlisted JSON structure and provider codes without accepting JSON success or exposing content',async()=>{
  const failure=await run(Response.json({object:'response',status:'failed',error:{code:'insufficient_quota',message:secret},output:secret}));
  expect(failure).toHaveProperty('responseDiagnostic',{streamReason:'trailing_frame',mime:'json',bodyRead:'complete',bodyShape:'object',responseType:'response',responseStatus:'failed',errorCode:'insufficient_quota',sseFraming:false,sseCompleted:false,hasDetail:false,hasError:true,responseObject:true});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});logPlanFailure('responses',failure);
  const log=JSON.stringify(warn.mock.calls);expect(log).toContain('insufficient_quota');expect(log).not.toContain(secret);expect(log).not.toContain('fixture-token');
 });
 it('never accepts a completed JSON response and suppresses arbitrary type, status and error codes',async()=>{
  const failure=await run(Response.json({type:secret,status:secret,error:{code:secret,message:secret}}));
  expect(failure).toHaveProperty('responseDiagnostic',{streamReason:'trailing_frame',mime:'json',bodyRead:'complete',bodyShape:'object',sseFraming:false,sseCompleted:false,hasDetail:false,hasError:true,responseObject:false});
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

it.each([
 ['invalid plan credential', 'invalid_plan_credential'],
 ['invalid identity', 'invalid_identity'],
 ['missing identity', 'missing_identity'],
 ['expired credential', 'expired_credential'],
 ['OS credential protection unavailable', 'credential_protection_unavailable'],
 ['invalid credential file', 'invalid_credential_file'],
 ['credential owner mismatch', 'credential_owner_mismatch'],
 ['not connected', 'not_connected'],
 ['response too large', 'response_oversize'],
 [secret, 'local_failure'],
])('classifies fixed local failure %s without exposing arbitrary error messages', (message, category) => {
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
 logPlanFailure('catalog', new Error(message));
 expect(warn).toHaveBeenCalledExactlyOnceWith(`[chatgpt-plan] catalog: ${category}`);
 expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
});

describe('safe failure metadata from bounded SSE frames', () => {
 const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
 it.each(['max_output_tokens', 'max_messages', 'content_filter', 'steered'])('projects HTTP200 incomplete reason %s without provider details', async reason => {
  const value = {type: 'response.incomplete', response: {status: 'incomplete', incomplete_details: {reason}, id: secret, output: [{text: secret}], error: {code: 'invalid_request_error', message: secret}}, detail: secret};
  const failure = await run(new Response(frame(value), {headers: {'content-type': 'text/event-stream'}}), undefined, 'incomplete_stream');
  expect(failure.responseDiagnostic).toMatchObject({responseType: 'response.incomplete', responseStatus: 'incomplete', incompleteReason: reason, errorCode: 'invalid_request_error', sseFraming: true, sseCompleted: false});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); logPlanFailure('responses', failure);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret); expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-token');
 });
 it('projects an allowlisted stream error code and nested failed response', async () => {
  for (const event of [{type: 'error', code: 'rate_limit_exceeded', message: secret}, {type: 'response.failed', response: {status: 'failed', error: {code: 'invalid_request_error', message: secret}}}]) {
   const failure = await run(new Response(frame(event)), undefined, 'incomplete_stream');
   expect(failure.responseDiagnostic).toMatchObject({responseType: event.type, errorCode: event.type === 'error' ? 'rate_limit_exceeded' : 'invalid_request_error'});
   expect(JSON.stringify(failure)).not.toContain(secret);
  }
 });
 it.each(['server_error', 'invalid_prompt', 'invalid_image'])('projects documented SSE response failure code %s only', async code => {
  const failure = await run(new Response(frame({type: 'response.failed', response: {status: 'failed', error: {code, message: secret}}})), undefined, 'incomplete_stream');
  expect(failure.responseDiagnostic).toMatchObject({responseType: 'response.failed', responseStatus: 'failed', errorCode: code});
  expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('drops unknown reasons, statuses, codes, IDs and private SSE text', async () => {
  const failure = await run(new Response(frame({type: 'response.incomplete', response: {status: secret, incomplete_details: {reason: secret}, error: {code: secret, message: secret}, output: secret, id: secret}})), undefined, 'incomplete_stream');
  expect(failure.responseDiagnostic?.responseType).toBe('response.incomplete');
  expect(failure.responseDiagnostic).not.toHaveProperty('incompleteReason'); expect(failure.responseDiagnostic).not.toHaveProperty('responseStatus'); expect(failure.responseDiagnostic).not.toHaveProperty('errorCode');
  expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('finds a safe terminal failure after a large delta while diagnostic parsing stays bounded', async () => {
  const prefix = frame({type: 'response.output_text.delta', delta: secret.repeat(1200)});
  const failure = await run(new Response(prefix + frame({type: 'response.incomplete', response: {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}}})), undefined, 'incomplete_stream');
  expect(failure.responseDiagnostic).toMatchObject({bodyRead: 'oversize', responseType: 'response.incomplete', incompleteReason: 'max_output_tokens'});
  expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('ignores malformed or oversized event metadata without logging its body', async () => {
  for (const text of ['data: { malformed ' + secret + ' }\n\n', frame({type: 'response.incomplete', response: {status: 'incomplete', incomplete_details: {reason: secret.repeat(1200)}}})]) {
   const failure = await run(new Response(text), undefined, text.includes('malformed') ? 'invalid_stream' : 'incomplete_stream');
   expect(failure.responseDiagnostic).not.toHaveProperty('incompleteReason'); expect(JSON.stringify(failure)).not.toContain(secret);
  }
 });
 it('retains the first terminal failure even if a later completed event follows', async () => {
  const failure = await run(new Response(frame({type: 'response.incomplete', response: {status: 'incomplete', incomplete_details: {reason: 'content_filter'}}}) + frame({type: 'response.completed', response: {status: 'completed', model: 'fixture-model'}})), undefined, 'incomplete_stream');
  expect(failure.responseDiagnostic).toMatchObject({responseType: 'response.incomplete', responseStatus: 'incomplete', incompleteReason: 'content_filter', sseCompleted: true});
 });
 it('handles malformed non-string event types without losing the original safe failure', async () => {
  const failure = await run(new Response(frame({type: {toString: null}, message: secret})), undefined, 'invalid_stream');
  expect(failure.responseDiagnostic).not.toHaveProperty('responseType'); expect(JSON.stringify(failure)).not.toContain(secret);
 });
 it('sanitizes new reason fields again at the actual logger boundary', () => {
  const failure = new PlanFailure('responses', 'incomplete_stream', 200);
  Object.assign(failure, {responseDiagnostic: {incompleteReason: secret, errorCode: secret, output: secret, responseType: 'response.incomplete'}});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); logPlanFailure('responses', failure);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret); expect(JSON.stringify(warn.mock.calls)).not.toContain('output');
 });
});

describe('failure-only safe inference correlation', () => {
 const requestId = '10000000-0000-4000-8000-000000000001';
 const runId = '20000000-0000-4000-8000-000000000001';
 const computerId = '30000000-0000-4000-8000-000000000001';
 it('retains strict UUID correlation with a generated UTC observation timestamp', () => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime('2026-10-13T06:30:00.000Z');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logPlanFailure('responses', new PlanFailure('responses', 'incomplete_stream', 200), {requestId, runId, computerId, requestClass: 'interactive', observedAt: secret});
  expect(warn).toHaveBeenCalledExactlyOnceWith(`[chatgpt-plan] responses: incomplete_stream (http 200) ${JSON.stringify({correlation: {requestId, runId, computerId, requestClass: 'interactive', observedAt: '2026-10-13T06:30:00.000Z'}})}`);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
 });
 it('retains the exact canonical opaque run ID grammar', () => {
  vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime('2026-10-13T06:30:00.000Z');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const canonicalRunId = 'run_0123456789abcdef0123456789abcdef';
  logPlanFailure('responses', new PlanFailure('responses', 'incomplete_stream', 200), {runId: canonicalRunId});
  expect(warn).toHaveBeenCalledExactlyOnceWith(`[chatgpt-plan] responses: incomplete_stream (http 200) ${JSON.stringify({correlation: {runId: canonicalRunId, observedAt: '2026-10-13T06:30:00.000Z'}})}`);
 });
 it.each(['run_credential', 'run_0123456789abcdef0123456789abcdef_suffix', 'run_0123456789abcdef0123456789abcdef\n', 'run_0123456789ABCDEF0123456789ABCDEF'])('drops noncanonical run references %j', runId => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logPlanFailure('responses', new PlanFailure('responses', 'incomplete_stream', 200), {runId});
  expect(warn).toHaveBeenCalledExactlyOnceWith('[chatgpt-plan] responses: incomplete_stream (http 200)');
 });
 it('drops arbitrary references, malformed UUIDs, unknown classes and private context fields', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logPlanFailure('responses', new PlanFailure('responses', 'incomplete_stream', 200), {requestId: secret, runId: 'run_private_reference', computerId: '30000000-0000-0000-0000-000000000001', requestClass: secret, model: secret, accountId: secret, body: secret, authorization: secret});
  expect(warn).toHaveBeenCalledExactlyOnceWith('[chatgpt-plan] responses: incomplete_stream (http 200)');
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret); expect(JSON.stringify(warn.mock.calls)).not.toContain('run_private_reference');
 });
});
