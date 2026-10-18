import {describe,expect,it,vi} from 'vitest';
import {newestWorkflowRun} from '../../scripts/ci/dedicated-history.mjs';
const repo={owner:'HamedMP',repo:'matrix-os'},workflow={id:98};
const scope={kind:'requester',headSha:'a'.repeat(40),headRef:'child'};
const row=(id:number,relevant=false)=>({id,run_attempt:1,relevant});
const fixture=(load:(args:any)=>any[])=>({rest:{actions:{listWorkflowRuns:vi.fn(async(args:any)=>({data:{workflow_runs:load(args)}}))}}});
describe('bounded relevant newest-first run discovery',()=>{
 it('compares all event streams and never lets an older match hide a newer queue entry',async()=>{
  const github=fixture(args=>args.event==='pull_request'?[row(301,true)]:[row(302,true)]);
  expect((await newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).id).toBe(302);
 });
 it('continues a full unmatched page while it can contain a run newer than the established match',async()=>{
  const github=fixture(args=>args.event==='pull_request'?(args.page===1?Array.from({length:100},(_,i)=>row(500-i)):[row(350,true)]):[row(301,true)]);
  expect((await newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).id).toBe(350);
  expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({event:'pull_request',head_sha:scope.headSha,branch:'child',page:2,request:{timeout:10000}}));
 });
 it('does not inspect older full pages once their ID boundary is below the newest authenticated result',async()=>{
  const github=fixture(args=>args.event==='pull_request'?[row(400,true)]:Array.from({length:100},(_,i)=>row(300-i)));
  expect((await newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).id).toBe(400);
  expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(2);
 });
 it('fails closed rather than returning an old result when relevant newer history exceeds the bound',async()=>{
  const github=fixture(args=>args.event==='pull_request'?[row(1,true)]:Array.from({length:100},(_,i)=>row(1000-(args.page-1)*100-i)));
  await expect(newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).rejects.toThrow(/bounded/);
  expect(Math.max(...github.rest.actions.listWorkflowRuns.mock.calls.map(([args])=>args.page))).toBe(3);
 });
 it.each([{rows:[]},{rows:[row(1)]}])('returns absent only after bounded relevant streams are exhausted (%j)',({rows})=>{
  const github=fixture(()=>rows);return expect(newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).resolves.toBeUndefined();
 });
 it('rejects API denial and malformed run identity',async()=>{
  const github=fixture(()=>[row(-1)]);await expect(newestWorkflowRun(github,repo,workflow,()=>true,scope)).rejects.toThrow(/Invalid/);
  github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error('API denied'));await expect(newestWorkflowRun(github,repo,workflow,()=>true,scope)).rejects.toThrow('API denied');
 });
});

it('cannot accept a matching API run without a valid attempt identity',async()=>{
 const github=fixture(()=>[{...row(123,true),run_attempt:undefined}]);
 await expect(newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,scope)).rejects.toThrow(/Invalid/);
});

it('finds the newest authenticated controller behind 2500 unrelated runs, beyond the API 1000-result window',async()=>{
 const runs=Array.from({length:2600},(_,i)=>({...row(3000-i,i===2500),created_at:new Date(Date.UTC(2026,9,15,0,0,3000-i)).toISOString()}));
 const github=fixture(args=>{
  if(args.branch!=='main')return [];
  const filtered=runs.filter(run=>!args.created||Date.parse(run.created_at)<=Date.parse(args.created.slice(2)));
  return filtered.slice((args.page-1)*100,Math.min(args.page*100,1000));
 });
 expect((await newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,{kind:'controller',headSha:scope.headSha,headRef:'child'})).id).toBe(500);
 expect(github.rest.actions.listWorkflowRuns.mock.calls.some(([args])=>args.created)).toBe(true);
 expect(github.rest.actions.listWorkflowRuns.mock.calls.length).toBeLessThan(40);
});

it('never skips another run sharing the inclusive creation-time boundary',async()=>{
 const runs=Array.from({length:450},(_,i)=>({...row(1000-i,i===320),created_at:new Date(Date.UTC(2026,9,15,0,0,Math.floor((1000-i)/50))).toISOString()}));
 const github=fixture(args=>args.branch!=='main'?[]:runs.filter(run=>!args.created||Date.parse(run.created_at)<=Date.parse(args.created.slice(2))).slice((args.page-1)*100,args.page*100));
 expect((await newestWorkflowRun(github,repo,workflow,(r:any)=>r.relevant,{kind:'controller',headSha:scope.headSha,headRef:'child'})).id).toBe(680);
});
it('fails closed when GitHub cannot expose all runs in a saturated single second',async()=>{
 const github=fixture(args=>args.branch!=='main'?[]:Array.from({length:100},(_,i)=>({...row(2000-(args.page-1)*100-i),created_at:'2026-10-15T00:00:00Z'})));
 await expect(newestWorkflowRun(github,repo,workflow,()=>false,{kind:'controller',headSha:scope.headSha,headRef:'child'})).rejects.toThrow(/bounded API/);
 expect(Math.max(...github.rest.actions.listWorkflowRuns.mock.calls.map(([args])=>args.page))).toBe(10);
});
it('retains a bounded API budget even for arbitrarily deep timestamped traffic',async()=>{
 let sequence=20000;
 const github=fixture(args=>args.branch!=='main'?[]:Array.from({length:100},()=>{const id=sequence--;return{...row(id),created_at:new Date(Date.UTC(2026,9,15,0,0,id)).toISOString()};}));
 await expect(newestWorkflowRun(github,repo,workflow,()=>false,{kind:'controller',headSha:scope.headSha,headRef:'child'})).rejects.toThrow(/bounded request/);
 expect(github.rest.actions.listWorkflowRuns.mock.calls.length).toBe(100);
});

it('awaits an asynchronous origin verdict instead of treating a rejected Promise as authenticated coverage',async()=>{
 const github=fixture(args=>args.event==='pull_request'?[row(400)]:[row(401)]);
 expect(await newestWorkflowRun(github,repo,workflow,async()=>false,scope)).toBeUndefined();
});
it('awaits origin verification before comparing the newest requester generation',async()=>{
 const github=fixture(args=>args.event==='pull_request'?[row(400,true)]:[row(401,false)]);
 expect((await newestWorkflowRun(github,repo,workflow,async(r:any)=>r.relevant,scope)).id).toBe(400);
});

describe('requester-bounded controller creation history',()=>{
 const floor='2026-10-18T11:50:00.000Z';
 const controllerScope={kind:'controller',headSha:scope.headSha,headRef:scope.headRef,notBefore:floor};
 function bounds(created:string|undefined){
  if(!created)return {start:-Infinity,end:Infinity};
  if(created.startsWith('>='))return {start:Date.parse(created.slice(2)),end:Infinity};
  if(created.startsWith('<='))return {start:-Infinity,end:Date.parse(created.slice(2))};
  const [start,end]=created.split('..');return {start:Date.parse(start),end:Date.parse(end)};
 }
 function history(runs:any[]){
  return fixture(args=>{
   if(args.event!=='workflow_run'||args.branch!=='main')return [];
   const {start,end}=bounds(args.created);
   return runs.filter(run=>Date.parse(run.created_at)>=start&&Date.parse(run.created_at)<=end)
    .slice((args.page-1)*100,Math.min(args.page*100,1000));
  });
 }
 it('returns no controller without exhausting older Main traffic outside the authenticated requester floor',async()=>{
  const older=Array.from({length:12000},(_,i)=>({...row(20000-i),created_at:new Date(Date.UTC(2026,9,18,10,0,-i)).toISOString()}));
  const github=history(older);
  await expect(newestWorkflowRun(github,repo,workflow,()=>false,controllerScope)).resolves.toBeUndefined();
  expect(github.rest.actions.listWorkflowRuns.mock.calls.length).toBeLessThanOrEqual(3);
  expect(github.rest.actions.listWorkflowRuns.mock.calls.every(([args])=>bounds(args.created).start===Date.parse(floor))).toBe(true);
 });
 it('retains a legitimate same-event PTR controller created shortly before its requester',async()=>{
  const controller={...row(29999,true),created_at:'2026-10-18T11:59:30Z'};
  const github=fixture(args=>args.event==='pull_request_target'?[controller]:[]);
  expect(await newestWorkflowRun(github,repo,workflow,(run:any)=>run.relevant,controllerScope)).toBe(controller);
  expect(github.rest.actions.listWorkflowRuns.mock.calls.every(([args])=>bounds(args.created).start===Date.parse(floor))).toBe(true);
 });
 it('preserves the inclusive lower floor when advancing the upper creation cursor',async()=>{
  const recent=Array.from({length:700},(_,i)=>({...row(30000-i,i===650),created_at:new Date(Date.UTC(2026,9,18,12,0,0)-i*500).toISOString()}));
  const older=Array.from({length:12000},(_,i)=>({...row(20000-i),created_at:new Date(Date.UTC(2026,9,18,10,0,-i)).toISOString()}));
  const github=history([...recent,...older]);
  expect((await newestWorkflowRun(github,repo,workflow,(run:any)=>run.relevant,controllerScope)).id).toBe(29350);
  const queries=github.rest.actions.listWorkflowRuns.mock.calls.map(([args])=>args.created);
  expect(queries.some(created=>Number.isFinite(bounds(created).end))).toBe(true);
  expect(queries.every(created=>bounds(created).start===Date.parse(floor))).toBe(true);
  expect(github.rest.actions.listWorkflowRuns.mock.calls.length).toBeLessThan(20);
 });
 it.each(['not-a-date','2026-02-30T00:00:00Z',0,{}])('rejects malformed creation floor before a workflow API request (%j)',async notBefore=>{
  const github=fixture(()=>[]);
  await expect(newestWorkflowRun(github,repo,workflow,()=>false,{...controllerScope,notBefore})).rejects.toThrow();
  expect(github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
 });
});
