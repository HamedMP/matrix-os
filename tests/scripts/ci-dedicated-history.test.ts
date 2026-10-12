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
