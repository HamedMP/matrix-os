import { afterEach, expect, it, vi } from 'vitest';
import { requestPlanResponse } from '../../desktop/src/main/chatgpt-plan/responses';
import { PlanFailure, logPlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { assertChatGptPlanCompleted } from '../../packages/gateway/src/bots/chatgpt-plan-wire';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const model='fixture-model';
const body=JSON.stringify({model,input:[{role:'user',content:'fixture only'}],store:false,stream:true});
const completion=(status='completed',selectedModel=model)=>`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status,model:selectedModel}})}\n\n`;
function call(response:Response,signal:AbortSignal=new AbortController().signal){
 const fetchFn=vi.fn(async()=>response),validate=vi.fn();
 return {fetchFn,validate,result:requestPlanResponse({fetchFn,body,model,signal,accessToken:async()=> 'fixture-token',validate})};
}
it.each(['application/octet-stream',undefined,'text/event-stream; charset=utf-8','text/plain','text/event-stream-private'])('accepts actual completed SSE regardless of MIME %s',async(mime)=>{
 const delta=`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:'fixture '.repeat(4000)})}\n\n`;
 const text=delta+completion();expect(Buffer.byteLength(text)).toBeGreaterThan(16*1024);
 const response=new Response(text,{headers:mime?{'content-type':mime}:{}});if(mime===undefined)response.headers.delete('content-type');const x=call(response);
 await expect(x.result).resolves.toBe(text);expect(x.fetchFn).toHaveBeenCalledOnce();expect(x.validate).toHaveBeenCalledTimes(3);
});
it('joins fragmented multiline SSE with CRLF frames and comments',async()=>{
 const text=': heartbeat\r\nevent: response.created\r\ndata: {"type":\r\ndata: "response.created"}\r\n\r\n'+completion().replace(/\n/g,'\r\n');
 const encoded=new TextEncoder().encode(text);
 const stream=new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=7)controller.enqueue(encoded.slice(i,i+7));controller.close();}});
 await expect(call(new Response(stream)).result).resolves.toBe(text);
});
it('preserves a completed lone-CR SSE response through the actual Gateway completion boundary',async()=>{
 const text=completion().replace(/\n/g,'\r');
 const delivered=await call(new Response(text,{headers:{'content-type':'application/octet-stream'}})).result;
 expect(()=>assertChatGptPlanCompleted(delivered,model)).not.toThrow();
 expect(delivered).toBe(completion());
});
it.each([
 ['JSON',JSON.stringify({object:'response',status:'completed',model}),'invalid_stream'],
 ['HTML','<html>fixture</html>','invalid_stream'],
 ['plain','completed fixture','invalid_stream'],
 ['delta only','data: {"type":"response.output_text.delta","delta":"fixture"}\n\n','incomplete_stream'],
 ['failed before complete','data: {"type":"response.failed"}\n\n'+completion(),'incomplete_stream'],
 ['incomplete before complete','data: {"type":"response.incomplete"}\n\n'+completion(),'incomplete_stream'],
 ['error event','data: {"type":"error"}\n\n'+completion(),'incomplete_stream'],
 ['wrong model',completion('completed','different-model'),'invalid_stream'],
 ['wrong completion status',completion('failed'),'invalid_stream'],
 ['malformed frame','data: { bad json }\n\n'+completion(),'invalid_stream'],
 ['missing event type','data: {"delta":"fixture"}\n\n'+completion(),'invalid_stream'],
 ['unframed prefix','not-sse\n\n'+completion(),'invalid_stream'],
 ['event mismatch','event: response.failed\ndata: {"type":"response.completed","response":{"status":"completed","model":"fixture-model"}}\n\n','invalid_stream'],
 ['unterminated completion',completion().trimEnd(),'incomplete_stream'],
 ['duplicate completion',completion()+completion(),'incomplete_stream'],
 ['failure after complete',completion()+'data: {"type":"response.failed"}\n\n','incomplete_stream'],
])('rejects %s without request replay',async(_name,text,category)=>{
 const x=call(new Response(text,{headers:{'content-type':'text/event-stream'}}));
 await expect(x.result).rejects.toMatchObject({category,httpStatus:200});expect(x.fetchFn).toHaveBeenCalledOnce();
});
it('keeps Stop effective on a stalled response and releases the reader even if cancellation stalls',async()=>{
 const controller=new AbortController();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"fixture"}\n\n'));},cancel});
 const x=call(new Response(stream),controller.signal);const rejection=expect(x.result).rejects.toMatchObject({category:'cancelled',httpStatus:200});
 await Promise.resolve();await Promise.resolve();controller.abort();await rejection;
 expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);expect(x.fetchFn).toHaveBeenCalledOnce();
});
it('enforces a 120s body deadline even with a custom response unaffected by fetch abort',async()=>{
 vi.useFakeTimers();const cancel=vi.fn();const stream=new ReadableStream({cancel});
 const x=call(new Response(stream));const rejection=expect(x.result).rejects.toMatchObject({category:'timeout',httpStatus:200});
 await vi.advanceTimersByTimeAsync(120_000);await rejection;expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);
});
it('caps complete-stream bytes at 1MiB without leaking stream text into failure diagnostics',async()=>{
 const secret='private fixture output ';const cancel=vi.fn();const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+secret.repeat(60_000)));},cancel});
 const x=call(new Response(stream));const failure=await x.result.catch(error=>error);
 expect(failure).toBeInstanceOf(PlanFailure);expect(failure).toMatchObject({category:'response_too_large',httpStatus:200});
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});logPlanFailure('responses',failure);
 expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);
});
it('rechecks current source authority after complete provider output',async()=>{
 const x=call(new Response(completion()));x.validate.mockImplementation(()=>{if(x.validate.mock.calls.length>=3)throw new Error('source changed');});
 await expect(x.result).rejects.toThrow('source changed');expect(x.fetchFn).toHaveBeenCalledOnce();
});
