import {describe,expect,it,vi} from 'vitest';
import * as helpers from '../../scripts/ci/dedicated-refresh.mjs';
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),main='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'};
function fixture(){
 const pull={number:2454,state:'open',draft:false,labels:[{name:'ci-linux'},{name:'ready-for-ci'}],head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'stack/parent',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge};
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull}))},git:{getRef:vi.fn(async()=>({data:{object:{sha:base}}}))},repos:{getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))}}};
 const context={sha:main,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/main'};
 const inputs={pr_number:'2454',head_sha:head,base_sha:base,source_sha:merge};
 return{github,pull,context,inputs};
}
describe('trusted same-head parent refresh',()=>{
 it('resolves a precise new merge under main CI definition without executing candidate helpers',async()=>{
  const f=fixture();expect(await helpers.resolveRequestingSource(f.github,repo,f.context,f.inputs)).toEqual({prNumber:2454,headSha:head,baseSha:base,sourceSha:merge,baseRef:'stack/parent',headRef:'child'});
 });
 it.each(['origin','head','base','merge','ref','labels','fork','parents','input'])('fails closed for %s mismatch',async kind=>{
  const f=fixture();if(kind==='origin')f.context.ref='refs/heads/child';if(kind==='head')f.pull.head.sha=main;if(kind==='base')f.pull.base.sha=main;if(kind==='merge')f.pull.merge_commit_sha=main;if(kind==='ref')f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:main}}});if(kind==='labels')f.pull.labels=[];if(kind==='fork')f.pull.head.repo.full_name='other/repo';if(kind==='parents')f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:merge,parents:[{sha:head},{sha:base}]}});if(kind==='input')f.inputs.source_sha='main';
  await expect(helpers.resolveRequestingSource(f.github,repo,f.context,f.inputs)).rejects.toThrow();
 });
 it('authenticates actual main dispatch API shape with immutable tuple marker and no PR rows',()=>{
  const f=fixture();const run={id:123,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_sha:main,head_branch:'main',run_attempt:1,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:helpers.refreshMarker({prNumber:2454,headSha:head,baseSha:base,sourceSha:merge}),pull_requests:[]};
  expect(helpers.authenticatedRequestingRun(run,repo,{...f.inputs,prNumber:2454,headSha:head,baseSha:base,sourceSha:merge},{id:98})).toBe(true);
  for(const change of [{head_branch:'child'},{workflow_id:99},{event:'repository_dispatch'},{display_title:helpers.refreshMarker({prNumber:2454,headSha:head,baseSha:main,sourceSha:merge})},{head_repository:{full_name:'other/repo'}}])expect(helpers.authenticatedRequestingRun({...run,...change},repo,{prNumber:2454,headSha:head,baseSha:base,sourceSha:merge},{id:98})).toBe(false);
 });
});

it('pins every refreshed lane checkout and preserves mandatory hosted gates under shadow',async()=>{
 const {readFileSync}=await import('node:fs');const {parse}=await import('yaml');
 const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
 expect(ci.on.workflow_dispatch.inputs).toEqual(expect.objectContaining({pr_number:expect.any(Object),head_sha:expect.any(Object),base_sha:expect.any(Object),source_sha:expect.any(Object)}));
 expect(ci.jobs.changes.steps.find((step:any)=>step.id==='refresh').with.script).toContain('resolveRequestingSource');
 for(const [key,job] of Object.entries(ci.jobs) as [string,any][]){
  if(key==='changes'||key==='ci-results')continue;
  for(const step of job.steps.filter((step:any)=>String(step.uses).startsWith('actions/checkout@')))expect(step.with.ref,key).toBe(key==='dedicated-linux'?'${{ github.sha }}':'${{ needs.changes.outputs.source_sha }}');
 }
 const dedicated=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
 expect(dedicated.on.workflow_run).toEqual({workflows:['CI'],types:['requested','in_progress','completed']});
 expect(dedicated.on.pull_request_target.types).toContain('opened');
 expect(dedicated.jobs.reconcile.if).not.toContain('vars.MATRIX_CI_DEDICATED');
 expect(dedicated.jobs.reconcile.steps.at(-1).with.script).toContain('reconcileSourceQualification');
});
it('admits a rerun through in_progress because GitHub requested events do not fire on reruns',async()=>{
 const f=fixture();const run={id:321,run_attempt:2,status:'in_progress',workflow_id:98,path:'.github/workflows/ci.yml',event:'pull_request',head_sha:head,head_branch:'child',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI coverage-v1 · ${merge}`,pull_requests:[{number:2454,head:{sha:head},base:{sha:base,ref:'stack/parent'}}]};
 const github={rest:{...f.github.rest,actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),getWorkflowRun:vi.fn(async()=>({data:run}))}}};
 await expect(helpers.admitRefreshController(github,repo,{action:'in_progress',workflow_run:run})).resolves.toMatchObject({prNumber:2454,headSha:head,baseSha:base,sourceSha:merge});
 run.run_attempt=1;await expect(helpers.admitRefreshController(github,repo,{action:'in_progress',workflow_run:run})).resolves.toMatchObject({prNumber:2454,baseRef:'stack/parent',sourceSha:merge});
 run.run_attempt=2;run.display_title=`CI coverage-v1 · ${main}`;await expect(helpers.admitRefreshController(github,repo,{action:'in_progress',workflow_run:run})).rejects.toThrow(/stale|admission/);
});
it('starts initial non-main CI through the default-main workflow_run bridge',async()=>{
 const {readFileSync}=await import('node:fs');const {parse}=await import('yaml');const w=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
 const condition=w.jobs.benchmark.if;expect(condition).toContain("startsWith(github.event.workflow_run.display_title, 'CI coverage-v1");
 expect(condition).not.toContain("github.event.action == 'in_progress' && github.event.workflow_run.run_attempt > 1");
 const admits=Function('vars','github','startsWith',`return (${condition});`);
 const vars={MATRIX_CI_DEDICATED_ENABLED:'true'};const github={ref:'refs/heads/main',event_name:'workflow_run',event:{action:'in_progress',workflow_run:{run_attempt:1,display_title:`CI coverage-v1 · ${merge}`}}};
 expect(admits(vars,github,(text:string,prefix:string)=>text.startsWith(prefix))).toBe(true);
 expect(admits(vars,{...github,ref:'refs/heads/stack/parent'},(text:string,prefix:string)=>text.startsWith(prefix))).toBe(false);
 expect(admits(vars,{...github,event:{...github.event,workflow_run:{run_attempt:1,display_title:`CI metadata-v1 · ${merge}`}}},(text:string,prefix:string)=>text.startsWith(prefix))).toBe(false);
});
