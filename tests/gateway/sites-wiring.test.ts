import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac, randomUUID } from 'node:crypto';
import { registerSiteRuntime } from '../../packages/gateway/src/sites/wiring.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
afterEach(() => vi.unstubAllGlobals());
async function runtime(syncToken?:string) {
 const app=new Hono();app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'user_sites');await next();});
 await registerSiteRuntime(app,{homePath:'/fixture',db:null,platformUrl:'https://platform.example',handle:'fixture',env:{MATRIX_USER_ID:'user_sites',MATRIX_AUTH_TOKEN:'legacy-handle-token',MATRIX_SYNC_RUNTIME_TOKEN:syncToken}});
 return app;
}
it('delegates owner publication lookup with the already-provisioned runtime-bound token, without a legacy fallback',async()=>{
 const request=vi.fn(async()=>new Response('{}',{status:404}));vi.stubGlobal('fetch',request);
 expect((await (await runtime()).request('/api/apps/launch/site')).status).toBe(503);expect(request).not.toHaveBeenCalled();
 expect((await (await runtime('runtime-bound-token')).request('/api/apps/launch/site')).status).toBe(404);
 expect(request.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({authorization:'Bearer runtime-bound-token'}));
});
it('signed submission proof uses the runtime-bound credential instead of the reusable handle bearer',async()=>{
 const app=await runtime('runtime-bound-token'),siteId=randomUUID();const raw=JSON.stringify({siteId,appSlug:'launch',versionId:randomUUID(),config:{forms:[{id:'rsvp',title:'RSVP',fields:{email:{type:'email',required:true}}}]},formId:'rsvp',fields:{email:'guest@example.com'},idempotencyKey:'request-0000000001'}),stamp=String(Date.now());
 const send=(secret:string)=>app.request(`/api/internal/sites/${siteId}/submit`,{method:'POST',body:raw,headers:{'content-type':'application/json','x-matrix-site-timestamp':stamp,'x-matrix-site-signature':createHmac('sha256',secret).update(`${stamp}.${raw}`).digest('hex')}});
 expect((await send('legacy-handle-token')).status).toBe(401);expect((await send('runtime-bound-token')).status).toBe(503);
});
