import { describe,it,expect,vi } from 'vitest';
import { createMailRoutes } from '../../packages/gateway/src/mail/routes.js';
const body=(appId='edition',action='sources',payload={})=>({appId,action,payload});
describe('mail action boundary',()=>{
 it('requires runtime owner and installed consumer before archive access',async()=>{
  const handle=vi.fn();const app=createMailRoutes({resolveOwner:()=>null,installed:async()=>true,handle});
  expect((await app.request('/action',{method:'POST',body:JSON.stringify(body())})).status).toBe(403);expect(handle).not.toHaveBeenCalled();
  const absent=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>false,handle});expect((await absent.request('/action',{method:'POST',body:JSON.stringify(body())})).status).toBe(403);
 });
 it('allows only read consumers, rejects forged fields and bounds bodies',async()=>{
  const handle=vi.fn(async()=>({sources:[]}));const app=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>true,handle});
  expect((await app.request('/action',{method:'POST',body:JSON.stringify(body('folio','sync',{sourceId:'one'}))})).status).toBe(403);
  expect((await app.request('/action',{method:'POST',body:JSON.stringify({...body(),ownerId:'other'})})).status).toBe(400);
  expect((await app.request('/action',{method:'POST',body:' '.repeat(17000)})).status).toBe(413);
  const ok=await app.request('/action',{method:'POST',body:JSON.stringify(body())});expect(ok.status).toBe(200);expect(ok.headers.get('cache-control')).toBe('no-store');expect(handle).toHaveBeenCalledWith('owner',body(),expect.any(AbortSignal));
 });
 it('contains server errors and uses per-action deadlines',async()=>{
  const app=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>true,handle:async()=>{throw new Error('postgres://secret@example');}});
  const res=await app.request('/action',{method:'POST',body:JSON.stringify(body())});expect(res.status).toBe(503);expect(await res.text()).not.toContain('secret');
 });
});
it('gives agents a separate read-only route with no cleanup or grant capability',async()=>{
 const handle=vi.fn(async()=>({sources:[]}));const app=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>true,handle});
 expect((await app.request('/read',{method:'POST',body:JSON.stringify(body('folio'))})).status).toBe(200);
 expect((await app.request('/read',{method:'POST',body:JSON.stringify(body('edition','cleanup-preview',{messageIds:['m1']}))})).status).toBe(403);
 expect(handle).toHaveBeenCalledOnce();
});
it('does not normalize encoded aliases into the agent read capability',async()=>{const handle=vi.fn();const app=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>true,handle});for(const path of ['/read/','/%72ead'])expect((await app.request(path,{method:'POST',body:JSON.stringify(body())})).status).toBe(404);expect(handle).not.toHaveBeenCalled();});
