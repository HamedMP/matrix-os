import {describe,it,expect} from 'vitest';import {Hono} from 'hono';
import {registerAppStoreRoutes} from '../../../packages/gateway/src/app-store/routes.js';
describe('App Store route boundary',()=>{
 it('does not expose configured status without an owner principal',async()=>{
  const app=new Hono();app.use('*',async(c,next)=>{c.set('authContextReady' as never,true as never);await next();});registerAppStoreRoutes(app,{homePath:'/tmp',ownerIds:['owner']});
  expect((await app.request('/api/app-store/status')).status).toBe(401);
 });
 it('rejects non-owner principals',async()=>{
  const app=new Hono();app.use('*',async(c,next)=>{c.set('authContextReady' as never,true as never);c.set('platformUserId' as never,'intruder' as never);await next();});registerAppStoreRoutes(app,{homePath:'/tmp',ownerIds:['owner']});
  expect((await app.request('/api/app-store/status')).status).not.toBe(200);
 });
});
