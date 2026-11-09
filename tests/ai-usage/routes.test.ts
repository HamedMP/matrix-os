import {it,expect,vi} from 'vitest';
import {createAiUsageRoutes} from '../../packages/gateway/src/ai-usage/routes';
const data={version:1 as const,events:[],issues:3};
it('permits only the verified runtime owner to scan fixed roots',async()=>{
 const scan=vi.fn(async()=>data);let owner:string|null=null;
 const app=createAiUsageRoutes({homePath:'/owner',runtimeOwnerId:'owner',getOwnerId:()=>owner,scan});
 expect((await app.request('/api/ai-usage')).status).toBe(401);owner='guest';
 expect((await app.request('/api/ai-usage')).status).toBe(403);expect(scan).not.toHaveBeenCalled();owner='owner';
 expect((await app.request('/api/ai-usage?home=/other')).status).toBe(400);
 const response=await app.request('/api/ai-usage');expect(response.status).toBe(200);expect(await response.json()).toEqual(data);
 expect(scan.mock.calls[0][0]).toEqual(['/owner/.claude/projects','/owner/.codex/sessions','/owner/.codex/archived_sessions']);
 expect(response.headers.get('cache-control')).toBe('no-store');
});
it('reports missing configuration and scan failure without exposing filesystem errors',async()=>{
 const missing=createAiUsageRoutes({homePath:'/owner',getOwnerId:()=> 'owner'});expect((await missing.request('/api/ai-usage')).status).toBe(503);
 const app=createAiUsageRoutes({homePath:'/owner',runtimeOwnerId:'owner',getOwnerId:()=> 'owner',scan:async()=>{throw new Error('/private/secret');}});
 const response=await app.request('/api/ai-usage');expect(response.status).toBe(503);expect(await response.text()).not.toContain('/private');
});
