import {afterEach,expect,it,vi} from 'vitest';
import {handleEdgeRouterRequest} from '../../packages/edge-router/src/index.js';
import {createHash} from 'node:crypto';
const env={EDGE_ROUTER_SECRET:'edge-secret',PLATFORM_ORIGIN:'https://platform.example.run.app'};
afterEach(()=>vi.restoreAllMocks());
it('forwards complete eleven MiB email intake bodies with both auth layers intact',async()=>{
 const bytes=new Uint8Array(11*1024*1024).fill(65);bytes[123]=0;bytes[bytes.length-1]=255;
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('validated',{status:422}));
 const response=await handleEdgeRouterRequest(new Request('https://api.matrix-os.com/api/ats/mail',{method:'POST',headers:{authorization:'Bearer mail-secret','content-type':'application/json'},body:bytes}),env);
 expect(response.status).toBe(422);expect(fetcher).toHaveBeenCalledOnce();
 const forwarded=fetcher.mock.calls[0][0] as Request;
 expect(forwarded.headers.get('authorization')).toBe('Bearer mail-secret');expect(forwarded.headers.get('x-matrix-edge-secret')).toBe('edge-secret');
 const received=new Uint8Array(await forwarded.arrayBuffer());
 expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
});
it.each(['https://app.matrix-os.com/api/ats/mail','https://api.matrix-os.com/api/ats/mails','https://api.matrix-os.com/api/other'])('retains the ten MiB ceiling outside the exact intake route: %s',async url=>{
 const fetcher=vi.spyOn(globalThis,'fetch');
 const response=await handleEdgeRouterRequest(new Request(url,{method:'POST',headers:{'content-length':String(11*1024*1024)},body:'{}'}),env);
 expect(response.status).toBe(413);expect(fetcher).not.toHaveBeenCalled();
});
it('cancels oversized chunked mail before buffering the entire request',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch');let produced=0;const canceled=vi.fn();
 const body=new ReadableStream({pull(controller){produced++;controller.enqueue(new Uint8Array(64*1024));if(produced===900)controller.close();},cancel:canceled});
 const response=await handleEdgeRouterRequest(new Request('https://api.matrix-os.com/api/ats/mail',{method:'POST',body,duplex:'half'} as RequestInit),env);
 expect(response.status).toBe(413);expect(canceled).toHaveBeenCalledOnce();expect(produced).toBeLessThan(520);expect(fetcher).not.toHaveBeenCalled();
});

it('returns a controlled error when request streaming fails',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch');vi.spyOn(console,'error').mockImplementation(()=>{});
 const body=new ReadableStream({start(controller){controller.error(new TypeError('private network details'));}});
 const response=await handleEdgeRouterRequest(new Request('https://api.matrix-os.com/api/ats/mail',{method:'POST',body,duplex:'half'} as RequestInit),env);
 expect(response.status).toBe(400);expect(await response.text()).toBe('invalid request body');expect(fetcher).not.toHaveBeenCalled();
});
it('keeps the size rejection when upstream cancellation fails',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch');vi.spyOn(console,'error').mockImplementation(()=>{});
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32*1024*1024+1));},cancel(){throw new Error('cancel failed');}});
 const response=await handleEdgeRouterRequest(new Request('https://api.matrix-os.com/api/ats/mail',{method:'POST',body,duplex:'half'} as RequestInit),env);
 expect(response.status).toBe(413);expect(fetcher).not.toHaveBeenCalled();
});
