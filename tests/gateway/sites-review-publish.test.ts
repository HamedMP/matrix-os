import { createPublicationDeadline } from '../../packages/gateway/src/sites/publish-deadline.js';
import { SITE_PUBLISH_TIMEOUT_MS } from '@matrix-os/contracts';
import { siteBuildFixture } from './site-build-fixture.js';
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
  const platform={request:vi.fn().mockResolvedValue({id:'site'})},build=siteBuildFixture({build:vi.fn().mockResolvedValue({ok:true})});
  const app=new Hono();app.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'owner');await next();});app.route('/',createSiteRoutes({homePath:home,ownerIds:['owner'],platform,submissions:storage?{} as any:null,build}));
  const response=await app.request('/api/apps/event/site',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Launch',reviewedConfig})});return {response,platform,build};
 }finally{await rm(home,{recursive:true,force:true});}
}
const forms=[{id:'contact',title:'Contact',fields:{email:{type:'email',required:true}}}];
describe('reviewed public declarations',()=>{
 it('passes the overall publication deadline without sharing one declared timeout across build stages',async()=>{
  const started=new Date('2026-10-20T00:00:00Z').getTime();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(started);
  try{const {response,build,platform}=await publish({data:{event:'Launch'},forms:[]},{data:{event:'Launch'},forms:[]},false);expect(response.status).toBe(200);expect(build.build).toHaveBeenCalledOnce();expect(build.build.mock.calls[0]?.[2]).toEqual({deadlineAt:started+SITE_PUBLISH_TIMEOUT_MS});expect(platform.request).toHaveBeenCalledOnce();}
  finally{vi.useRealTimers();}
 });
 it('requires storage only when live declaration includes visitor forms',async()=>{const {response,build,platform}=await publish({forms},{forms},false);expect(response.status).toBe(503);expect(build.build).not.toHaveBeenCalled();expect(platform.request).not.toHaveBeenCalled();});
 it('compares equivalent object fields independently of insertion order',async()=>{const publishing={data:{event:{title:'Launch',venue:'Online'},date:'Friday'},forms:[{id:'contact',title:'Contact',fields:{name:{type:'text',required:true},email:{type:'email',required:true}}}]};const reviewed={data:{date:'Friday',event:{venue:'Online',title:'Launch'}},forms:[{id:'contact',title:'Contact',fields:{email:{required:true,type:'email'},name:{required:true,type:'text'}}}]};expect((await publish(publishing,reviewed,true)).response.status).toBe(200);});
 it('still rejects changed values or array ordering before building',async()=>{for(const reviewed of [{data:{list:['second','first']},forms:[]},{data:{list:['first','changed']},forms:[]}]){const {response,build}=await publish({data:{list:['first','second']},forms:[]},reviewed,true);expect(response.status).toBe(409);expect(build.build).not.toHaveBeenCalled();}});
});

it.each(['aborted', 'expired', 'valid-slow'] as const)('enforces the whole publication budget for %s work before any public activation', async mode => {
 const home = await mkdtemp(join(tmpdir(), 'sites-deadline-'));
 const controller = new AbortController();
 const started = new Date('2026-10-16T00:00:00Z').getTime();
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(started);
 try {
  await mkdir(join(home, 'apps/event/dist'), { recursive: true });
  await writeFile(join(home, 'apps/event/dist/index.html'), '<html>Launch</html>');
  await writeFile(join(home, 'apps/event/matrix.json'), JSON.stringify({ name: 'Event', slug: 'event', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', build: { command: 'pnpm build', output: 'dist' } }));
  const platform = { request: vi.fn().mockResolvedValue({ id: 'site' }) };
  const build = siteBuildFixture({ build: vi.fn(async () => {
   if (mode === 'aborted') controller.abort();
   // Represent queue/install/build wall time without executing slow commands.
   vi.setSystemTime(started + (mode === 'expired' ? 270_000 : 170_000));
   return { ok: true };
  }) });
  const app = new Hono(); app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, 'owner'); await next(); });
  app.route('/', createSiteRoutes({ homePath: home, ownerIds: ['owner'], platform, submissions: null, build }));
  const response = await app.request('/api/apps/event/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedConfig: {} }), signal: controller.signal });
  expect(response.status).toBe(mode === 'valid-slow' ? 200 : 503);
  expect(platform.request).toHaveBeenCalledTimes(mode === 'valid-slow' ? 1 : 0);
 } finally { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); }
});

it('returns on caller abort without freeing a still-running build admission', async () => {
 const home = await mkdtemp(join(tmpdir(), 'sites-abort-queue-'));
 const finish = Promise.withResolvers<{ ok: true }>();
 const controllers = Array.from({ length: 4 }, () => new AbortController());
 const pending: Promise<Response>[] = [];
 try {
  await mkdir(join(home, 'apps/event/dist'), { recursive: true });
  await writeFile(join(home, 'apps/event/dist/index.html'), '<html>Launch</html>');
  await writeFile(join(home, 'apps/event/matrix.json'), JSON.stringify({ name: 'Event', slug: 'event', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', build: { command: 'pnpm build', output: 'dist' } }));
  const platform = { request: vi.fn().mockResolvedValue({ id: 'site' }) };
  const build = siteBuildFixture({ build: vi.fn(() => finish.promise) });
  const app = new Hono(); app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, 'owner'); await next(); });
  app.route('/', createSiteRoutes({ homePath: home, ownerIds: ['owner'], platform, submissions: null, build }));
  const request = (signal?: AbortSignal) => app.request('/api/apps/event/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedConfig: {} }), signal });
  pending.push(...controllers.map(c => request(c.signal)));
  await vi.waitFor(() => expect(build.build).toHaveBeenCalledTimes(4));
  controllers.forEach(c => c.abort());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([Promise.all(pending).then(r => r.map(x => x.status)), new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 100); })]);
  if (timer) clearTimeout(timer);
  expect(outcome).toEqual([503, 503, 503, 503]);
  expect((await request()).status).toBe(429);
  expect(platform.request).not.toHaveBeenCalled();
  finish.resolve({ ok: true });
  await vi.waitFor(async () => expect((await request()).status).toBe(200));
 } finally { finish.resolve({ ok: true }); await Promise.allSettled(pending); await rm(home, { recursive: true, force: true }); }
});

it('bounds queued publication waits and removes its deadline/listener after settling', async () => {
 vi.useFakeTimers();
 const caller = new AbortController(), work = Promise.withResolvers<void>();
 const deadline = createPublicationDeadline(caller.signal);
 const outcome = deadline.wait(work.promise).then(() => 'unexpected success', error => error.name);
 try {
  await vi.advanceTimersByTimeAsync(SITE_PUBLISH_TIMEOUT_MS);
  expect(await outcome).toBe('PublicationExpired');
  expect(() => deadline.check()).toThrow('Publication unavailable');
  work.resolve();
 } finally { deadline.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
});
