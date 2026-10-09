import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMiddleware } from '../../packages/gateway/src/auth.js';
import { Hono } from 'hono';
import { createHmac, randomUUID } from 'node:crypto';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { createSiteSubmitRoutes } from '../../packages/gateway/src/sites/submit-routes.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
const siteId=randomUUID(), versionId=randomUUID();
const config={data:{event:'Launch'},forms:[{id:'rsvp',title:'RSVP',fields:{email:{type:'email',required:true}}}]};
function ownerApp(user='owner',platform:any={request:vi.fn().mockResolvedValue(null)}) { const app=new Hono(); app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,user);await next();}); app.route('/',createSiteRoutes({homePath:'/unused',ownerIds:['owner'],platform,submissions:null})); return app; }
describe('owner publishing authentication',()=>{
 it('rejects a collaborator before machine delegation',async()=>{const platform={request:vi.fn()};const response=await ownerApp('collaborator',platform).request('/api/apps/event/site');expect(response.status).toBe(403);expect(platform.request).not.toHaveBeenCalled();});
 it('returns no publication and validates app paths',async()=>{expect((await ownerApp().request('/api/apps/event/site')).status).toBe(404);expect((await ownerApp().request('/api/apps/%24evil/site')).status).toBe(400);});
 it('fails safely when publication services are missing',async()=>{const response=await ownerApp('owner',null).request('/api/apps/event/site');expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Site unavailable'});});
 it('caps every mutation before JSON parsing',async()=>{const response=await ownerApp().request('/api/apps/event/site',{method:'DELETE',body:'x'.repeat(20000)});expect(response.status).toBe(413);});
});
describe('scoped platform submission route',()=>{
 function app() { const submit=vi.fn().mockResolvedValue(undefined); const app=new Hono();app.route('/',createSiteSubmitRoutes({serviceSecret:'token',submissions:{submit} as any}));return {app,submit}; }
 function request(body:any,id=siteId,secret='token'){const raw=JSON.stringify(body),stamp=String(Date.now()); return new Request('http://localhost/api/internal/sites/'+id+'/submit',{method:'POST',headers:{'content-type':'application/json','x-matrix-site-timestamp':stamp,'x-matrix-site-signature':createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex')},body:raw});}
 const body={siteId,appSlug:'event',versionId,config,formId:'rsvp',fields:{email:'a@example.com'},idempotencyKey:'1234567890123456'};
 it('requires service proof and path-bound site',async()=>{const {app,submit}=appFixture(); expect((await app.request(request(body,siteId,'wrong'))).status).toBe(401);expect((await app.request(request(body,randomUUID()))).status).toBe(400);expect(submit).not.toHaveBeenCalled();});
 function appFixture(){return app();}
 it('persists exact declared schema and returns acknowledgement only',async()=>{const {app,submit}=appFixture();const result=await app.request(request(body));expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true});expect(submit).toHaveBeenCalledWith(expect.objectContaining({siteId,fields:body.fields}));expect((await app.request(request({...body,fields:{email:'a@example.com',admin:true}}))).status).toBe(400);});
});

describe('full owner production deployment path',()=>{
 it.each([{kind:'visitor forms',publishing:config},{kind:'information guide',publishing:undefined}])('builds and publishes $kind with optional public configuration',async({publishing})=>{
  const publicConfig=publishing??{data:{},forms:[]};
  const home=await mkdtemp(join(tmpdir(),'matrix-site-route-'));
  try{
   const dir=join(home,'apps/event');await mkdir(join(dir,'dist'),{recursive:true});
   await writeFile(join(dir,'matrix.json'),JSON.stringify({name:'Event',slug:'event',version:'1.0.0',runtime:'vite',runtimeVersion:'1.0.0',build:{command:'pnpm build',output:'dist'},publishing}));await writeFile(join(dir,'dist/index.html'),'<html>Launch</html>');await writeFile(join(dir,'source-secret.env'),'private');
   const platform={request:vi.fn().mockResolvedValue({id:siteId})},build={build:vi.fn().mockResolvedValue({ok:true})};const app=new Hono();app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'owner');await next();});app.route('/',createSiteRoutes({homePath:home,ownerIds:['owner'],platform,submissions:{} as any,build}));
   const changed=await app.request('/api/apps/event/site',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Launch',reviewedConfig:{...publicConfig,data:{event:'Other'}}})});expect(changed.status).toBe(409);expect(build.build).not.toHaveBeenCalled();expect(platform.request).not.toHaveBeenCalled();
   const response=await app.request('/api/apps/event/site',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Launch',reviewedConfig:publicConfig})});expect(response.status).toBe(200);expect(build.build).toHaveBeenCalledOnce();expect(platform.request).toHaveBeenCalledWith('event','POST',expect.objectContaining({config:publicConfig,files:[{path:'index.html',contentType:'text/html',body:Buffer.from('<html>Launch</html>').toString('base64')}]}),'');
  }finally{await rm(home,{recursive:true,force:true});}
 });
 it('site proof only exempts the exact internal submit method/path',async()=>{
  const app=new Hono();app.use('*',authMiddleware('bearer-secret'));app.post('/api/internal/sites/:siteId/submit',c=>c.json({ok:true}));app.get('/api/internal/sites/:siteId/submit',c=>c.json({ok:true}));app.post('/api/internal/sites/:siteId/delete',c=>c.json({ok:true}));
  const headers={'x-matrix-site-signature':'fake','x-matrix-site-timestamp':String(Date.now())};
  expect((await app.request('/api/internal/sites/'+siteId+'/submit',{method:'POST',headers})).status).toBe(200);expect((await app.request('/api/internal/sites/'+siteId+'/submit',{headers})).status).toBe(401);expect((await app.request('/api/internal/sites/'+siteId+'/delete',{method:'POST',headers})).status).toBe(401);
 });
});
