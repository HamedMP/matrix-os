import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSitePlatformClient, SitePlatformError } from '../../packages/gateway/src/sites/platform-client.js';
import { randomUUID } from 'node:crypto';
const client=()=>createSitePlatformClient({url:'https://platform.example',token:'machine-token',handle:'owner',runtimeSlot:'main'});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('bounded site management transport',()=>{
 it('uses configured destination, machine proof and rejects redirects',async()=>{const missing=new Response('missing',{status:404});const fetch=vi.fn().mockResolvedValue(missing);vi.stubGlobal('fetch',fetch);expect(await client().request('event','GET')).toBeNull();expect(missing.bodyUsed).toBe(true);const [url,options]=fetch.mock.calls[0];expect(String(url)).toBe('https://platform.example/internal/containers/owner/sites/event?runtimeSlot=main');expect(options.headers.authorization).toBe('Bearer machine-token');expect(options.redirect).toBe('error');expect(options.signal).toBeInstanceOf(AbortSignal);});
 it('returns coarse unavailable on network, oversize and malformed responses',async()=>{for(const response of [new Error('postgres://secret/path'),new Response('x'.repeat(600000)),new Response('{}')]){vi.stubGlobal('fetch',response instanceof Error?vi.fn().mockRejectedValue(response):vi.fn().mockResolvedValue(response));await expect(client().request('event','GET')).rejects.toMatchObject({status:503,message:'Publishing request failed'});}});
 it('validates response and preserves conflict status',async()=>{const record={id:randomUUID(),appSlug:'event',title:'Launch',description:'',slug:null,url:'https://matrix.page/test',revision:1,status:'published',activeVersion:randomUUID(),versions:[],config:{data:{},forms:[]}};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(record))));expect(await client().request('event','GET')).toEqual(record);vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:409})));await expect(client().request('event','PATCH',{})).rejects.toEqual(new SitePlatformError(409));});
});

it('does not send already cancelled publication and propagates cancellation during transport', async () => {
 const cancelled = new AbortController(); cancelled.abort();
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(client().request('event', 'POST', {}, '', cancelled.signal)).rejects.toMatchObject({ status: 503 });
 expect(fetch).not.toHaveBeenCalled();
 const active = new AbortController();
 fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
 const request = client().request('event', 'POST', {}, '', active.signal).then(() => 'unexpected success', error => error);
 active.abort();
 expect(await request).toMatchObject({ status: 503, message: 'Publishing request failed' });
});


it('allows a valid deployment beyond thirty seconds within its remaining publication deadline', async () => {
 vi.useFakeTimers();
 vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;});
 const record={id:randomUUID(),appSlug:'event',title:'Launch',description:'',slug:null,url:'https://matrix.page/test',revision:1,status:'published',activeVersion:randomUUID(),versions:[],config:{data:{},forms:[]}};
 vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise<Response>((resolve,reject)=>{
  const aborted=()=>{clearTimeout(timer);reject(new Error('cancelled'));};
  const timer=setTimeout(()=>{options.signal.removeEventListener('abort',aborted);resolve(new Response(JSON.stringify(record)));},35000);
  options.signal.addEventListener('abort',aborted,{once:true});
 })));
 const pending=client().request('event','POST',{},'',undefined,Date.now()+120000).then(value=>({value}),error=>({error}));
 await vi.advanceTimersByTimeAsync(35000);
 expect(await pending).toEqual({value:record});
 expect(AbortSignal.timeout).toHaveBeenCalledWith(120000);
});

it('rejects expired or invalid deployment deadlines before any platform request', async () => {
 vi.useFakeTimers();
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 for(const deadline of [Date.now()-1,Date.now(),NaN,Infinity,Date.now()+270001,Date.now()+0.5]) {
  await expect(client().request('event','POST',{},'',undefined,deadline)).rejects.toMatchObject({status:503});
 }
 expect(fetch).not.toHaveBeenCalled();
});

it('bounds deployment by the remaining budget while retaining management timeouts and caller cancellation', async () => {
 vi.useFakeTimers();
 vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;});
 const fetch=vi.fn((_url,options)=>new Promise<Response>((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));vi.stubGlobal('fetch',fetch);
 const pending=client().request('event','POST',{},'',undefined,Date.now()+5000).catch(error=>error);
 expect(AbortSignal.timeout).toHaveBeenLastCalledWith(5000);await vi.advanceTimersByTimeAsync(5000);expect(await pending).toMatchObject({status:503});
 const caller=new AbortController();const cancelled=client().request('event','POST',{},'',caller.signal,Date.now()+120000).catch(error=>error);caller.abort();expect(await cancelled).toMatchObject({status:503});
 fetch.mockResolvedValueOnce(new Response('missing',{status:404}));expect(await client().request('event','GET')).toBeNull();expect(AbortSignal.timeout).toHaveBeenLastCalledWith(10000);
 fetch.mockResolvedValueOnce(new Response('{}',{status:409}));await expect(client().request('event','POST',{},'/rollback')).rejects.toMatchObject({status:409});expect(AbortSignal.timeout).toHaveBeenLastCalledWith(30000);
});
