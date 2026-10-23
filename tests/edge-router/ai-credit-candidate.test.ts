import { afterEach, expect, it, vi } from 'vitest';
import { handleEdgeRouterRequest } from '../../packages/edge-router/src/index.js';
const env = {
  EDGE_ROUTER_SECRET: 'edge-secret', PLATFORM_ORIGIN: 'https://matrix-platform.example.run.app',
  AI_CREDIT_CANDIDATE_ORIGIN: 'https://pr2851-credit---matrix-platform.example.run.app',
  AI_CREDIT_CANDIDATE_HANDLE: 'alice',
  AI_CREDIT_CANDIDATE_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
};
afterEach(() => vi.restoreAllMocks());
async function route(path: string, method='POST', body='{}', options=env, host='app.matrix-os.com') {
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('ok'));
  const response=await handleEdgeRouterRequest(new Request(`https://${host}${path}`, {
    method, headers:{authorization:'Bearer owner-session','content-type':'application/json'},
    ...(method==='GET'?{}:{body}),
  }),options);
  const request=fetcher.mock.calls.at(-1)![0] as Request;
  return {response,request};
}
it.each(['app.matrix-os.com','api.matrix-os.com'])('routes primary credit checkout on %s without changing auth/body',async host=>{
  const body=JSON.stringify({packageId:'usd_5',runtimeSlot:'primary',requestId:'123e4567-e89b-42d3-a456-426614174000'});
  const {response,request}=await route('/billing/ai-credit/checkout','POST',body,env,host);
  expect(request.url).toBe(`${env.AI_CREDIT_CANDIDATE_ORIGIN}/billing/ai-credit/checkout`);
  expect(await request.text()).toBe(body);expect(request.headers.get('authorization')).toBe('Bearer owner-session');
  expect(request.headers.get('x-matrix-edge-secret')).toBe('edge-secret');
  expect(response.headers.get('x-matrix-ai-credit-route')).toBe('candidate');
});
it('routes only the configured main funding summary',async()=>{
  const path='/internal/containers/alice/ai/funding-summary?runtimeSlot=primary';
  expect((await route(path)).request.url).toBe(env.AI_CREDIT_CANDIDATE_ORIGIN+path);
});
it.each([
 ['/internal/containers/bob/ai/funding-summary?runtimeSlot=primary','POST','{}'],
 ['/internal/containers/alice/ai/funding-summary?runtimeSlot=preview','POST','{}'],
 ['/internal/containers/alice/ai/funding-summary?runtimeSlot=primary&runtimeSlot=preview','POST','{}'],
 ['/internal/containers/alice/ai/funded-credential?runtimeSlot=primary','POST','{}'],
 ['/billing/ai-credit/history','GET','{}'],['/billing/ai-credit/checkout','GET','{}'],
 ['/billing/checkout','POST','{}'],['/billing/ai-credit/checkout','POST','{'],
 ['/billing/ai-credit/checkout','POST','{"runtimeSlot":"preview","packageId":"usd_5"}'],
 ['/billing/ai-credit/checkout','POST','{"runtimeSlot":"primary","packageId":"usd_5","padding":"'+ 'x'.repeat(17000)+'"}'],
])('preserves default route for %s %s',async(path,method,body)=>{
 const {response,request}=await route(path,method,body);expect(request.url).toBe(env.PLATFORM_ORIGIN+path);
 expect(response.headers.get('x-matrix-ai-credit-route')).toBeNull();
});
it.each([
 {AI_CREDIT_CANDIDATE_EXPIRES_AT:new Date(Date.now()-1).toISOString()},
 {AI_CREDIT_CANDIDATE_EXPIRES_AT:new Date(Date.now()+3*3600000).toISOString()},
 {AI_CREDIT_CANDIDATE_ORIGIN:'https://evil.example'},
 {AI_CREDIT_CANDIDATE_ORIGIN:'https://pr2851-credit---matrix-platform.example.run.app/path'},
 {AI_CREDIT_CANDIDATE_ORIGIN:'https://user:pass@pr2851-credit---matrix-platform.example.run.app'},
 {AI_CREDIT_CANDIDATE_HANDLE:''},
])('fails closed for invalid selector %j',async patch=>{
 const {request}=await route('/internal/containers/alice/ai/funding-summary?runtimeSlot=primary','POST','{}',{...env,...patch});
 expect(request.url).toContain(env.PLATFORM_ORIGIN+'/internal/');
});

it('does not accept an upstream-supplied candidate response marker',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('ok',{headers:{'x-matrix-ai-credit-route':'candidate'}}));
 const response=await handleEdgeRouterRequest(new Request('https://app.matrix-os.com/billing/ai-credit/history'),env);
 expect(response.headers.get('x-matrix-ai-credit-route')).toBeNull();expect(fetcher).toHaveBeenCalledOnce();
});
it('retains the independent Preview Chat route',async()=>{
 const options={...env,PREVIEW_CHAT_CANDIDATE_ORIGIN:'https://pr42-chat---matrix-platform.example.run.app',PREVIEW_CHAT_CANDIDATE_HANDLE:'pr-42',PREVIEW_CHAT_CANDIDATE_CHAT_ID:'chat_test',PREVIEW_CHAT_CANDIDATE_EXPIRES_AT:env.AI_CREDIT_CANDIDATE_EXPIRES_AT};
 const path='/vm/pr-42/api/chats/chat_test/turns';
 const {request,response}=await route(path,'POST','{}',options);
 expect(request.url).toBe(options.PREVIEW_CHAT_CANDIDATE_ORIGIN+path);expect(response.headers.get('x-matrix-preview-platform-route')).toBe('candidate');expect(response.headers.get('x-matrix-ai-credit-route')).toBeNull();
});
