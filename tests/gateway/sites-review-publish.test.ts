import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
async function publish(publishing:unknown,reviewedConfig:unknown,storage:boolean){
 const home=await mkdtemp(join(tmpdir(),'sites-review-publish-'));
 try{
  await mkdir(join(home,'apps/event/dist'),{recursive:true});await writeFile(join(home,'apps/event/dist/index.html'),'<html>Launch</html>');
  await writeFile(join(home,'apps/event/matrix.json'),JSON.stringify({name:'Event',slug:'event',version:'1.0.0',runtime:'vite',runtimeVersion:'1.0.0',build:{command:'pnpm build',output:'dist'},publishing}));
  const platform={request:vi.fn().mockResolvedValue({id:'site'})},build={build:vi.fn().mockResolvedValue({ok:true})};
  const app=new Hono();app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'owner');await next();});app.route('/',createSiteRoutes({homePath:home,ownerIds:['owner'],platform,submissions:storage?{} as any:null,build}));
  const response=await app.request('/api/apps/event/site',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Launch',reviewedConfig})});return {response,platform,build};
 }finally{await rm(home,{recursive:true,force:true});}
}
const forms=[{id:'contact',title:'Contact',fields:{email:{type:'email',required:true}}}];
describe('reviewed public declarations',()=>{
 it('publishes an information-only app without optional visitor storage',async()=>{const {response,build,platform}=await publish({data:{event:'Launch'},forms:[]},{data:{event:'Launch'},forms:[]},false);expect(response.status).toBe(200);expect(build.build).toHaveBeenCalledOnce();expect(platform.request).toHaveBeenCalledOnce();});
 it('requires storage only when live declaration includes visitor forms',async()=>{const {response,build,platform}=await publish({forms},{forms},false);expect(response.status).toBe(503);expect(build.build).not.toHaveBeenCalled();expect(platform.request).not.toHaveBeenCalled();});
 it('compares equivalent object fields independently of insertion order',async()=>{const publishing={data:{event:{title:'Launch',venue:'Online'},date:'Friday'},forms:[{id:'contact',title:'Contact',fields:{name:{type:'text',required:true},email:{type:'email',required:true}}}]};const reviewed={data:{date:'Friday',event:{venue:'Online',title:'Launch'}},forms:[{id:'contact',title:'Contact',fields:{email:{required:true,type:'email'},name:{required:true,type:'text'}}}]};expect((await publish(publishing,reviewed,true)).response.status).toBe(200);});
 it('still rejects changed values or array ordering before building',async()=>{for(const reviewed of [{data:{list:['second','first']},forms:[]},{data:{list:['first','changed']},forms:[]}]){const {response,build}=await publish({data:{list:['first','second']},forms:[]},reviewed,true);expect(response.status).toBe(409);expect(build.build).not.toHaveBeenCalled();}});
});
