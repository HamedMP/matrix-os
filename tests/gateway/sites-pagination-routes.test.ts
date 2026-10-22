import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
const siteId='550e8400-e29b-41d4-a716-446655440000';
const cursor='2026-10-09T12:00:00.123456Z|550e8400-e29b-41d4-a716-446655440001';
function fixture(){
 const list=vi.fn().mockResolvedValue({items:[],nextCursor:null}),platform={request:vi.fn().mockResolvedValue({id:siteId})};
 const app=new Hono();app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'owner');await next();});
 app.route('/',createSiteRoutes({homePath:'/unused',ownerIds:['owner'],platform,submissions:{list} as any}));return {app,list};
}
describe('submission list/export keyset boundary',()=>{
 it.each(['submissions','submissions/export'])('validates opaque cursor for %s before repository access',async(path)=>{
  const {app,list}=fixture();for(const value of ['50','',cursor+'x','bad|id'])expect((await app.request('/api/apps/event/site/'+path+'?cursor='+encodeURIComponent(value))).status).toBe(400);
  expect(list).not.toHaveBeenCalled();const response=await app.request('/api/apps/event/site/'+path+'?limit=2&cursor='+encodeURIComponent(cursor));expect(response.status).toBe(200);expect(list).toHaveBeenCalledWith(siteId,'event',2,cursor);expect(await response.json()).toEqual({submissions:[],nextCursor:null});
 });
 it.each(['submissions','submissions/export'])('starts %s without an offset',async(path)=>{
  const {app,list}=fixture();expect((await app.request('/api/apps/event/site/'+path)).status).toBe(200);expect(list).toHaveBeenCalledWith(siteId,'event',50,null);
 });
});
