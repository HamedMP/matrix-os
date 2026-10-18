import {describe,expect,it,vi} from 'vitest';
import {waitForDedicatedResult} from '../../scripts/ci/dedicated-result.mjs';
import {pinArtifactFixture} from './helpers/dedicated-artifact-fixture';

const head='a'.repeat(40),base='b'.repeat(40),source='c'.repeat(40),pin='d'.repeat(40);
const created='2026-10-18T12:00:00Z',floor='2026-10-18T11:50:00.000Z';
const repository={full_name:'HamedMP/matrix-os'};
function creationBounds(value:string|undefined){
 if(!value)return {start:-Infinity,end:Infinity};
 if(value.startsWith('>='))return {start:Date.parse(value.slice(2)),end:Infinity};
 if(value.startsWith('<='))return {start:-Infinity,end:Date.parse(value.slice(2))};
 const [start,end]=value.split('..');return {start:Date.parse(start),end:Date.parse(end)};
}
function fixture(kind:'pr'|'main'|'stack'='pr'){
 const main=kind==='main',baseRef=kind==='stack'?'feature/parent':'main';
 const expected={owner:'HamedMP',repo:'matrix-os',serverUrl:'https://github.com',
  requestingRunId:30000,requestingRunAttempt:1,prNumber:main?0:2440,headSha:main?source:head,
  baseSha:base,baseRef,headRef:main?'main':'feature/source',sourceSha:source,
  imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'delegated',
  ...(main?{sourceKind:'main',mergeParents:[base]}:{})};
 const requester={id:30000,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',
  event:main?'push':'pull_request',head_sha:expected.headSha,head_branch:expected.headRef,
  repository,head_repository:repository,status:'in_progress',conclusion:null,created_at:created,
  display_title:`CI coverage-v1 · ${source}`,
  pull_requests:main?[]:[{number:2440,head:{sha:head},base:{sha:base,ref:baseRef}}]};
 const requesterApi={...requester};
 const controller={id:29999,run_attempt:1,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',
  event:main?'workflow_run':'pull_request_target',head_sha:expected.headSha,head_branch:expected.headRef,
  repository,head_repository:repository,status:'completed',conclusion:'success',check_suite_id:456,
  created_at:main?'2026-10-18T12:00:30Z':'2026-10-18T11:59:30Z',
  display_title:main?`dedicated-refresh-v2 execution=true request=30000 title=CI coverage-v1 · ${source}`:
   `dedicated-ci-v2 pr=2440 head=${head} base=${base} requested=true`};
 const summary={schemaVersion:3,suite:'qualification',requestingRunId:30000,requestingRunAttempt:1,
  prNumber:expected.prNumber,headSha:expected.headSha,baseSha:base,baseRef,sourceSha:source,
  controllerRunId:controller.id,controllerAttempt:1,controllerSha:pin,controllerRef:'refs/heads/main',
  controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:expected.imageDigest,
  harnessDigest:expected.harnessDigest,mode:'delegated',receiptVerified:true,leaseId:'8'.repeat(32),
  ...(main?{sourceKind:'main',mergeParents:[base]}:{})};
 const check={id:10,name:'Dedicated CI Results',head_sha:expected.headSha,status:'completed',conclusion:'success',
  app:{slug:'github-actions'},check_suite:{id:456},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/29999',
  output:{summary:JSON.stringify(summary)}};
 const state={admitted:true,older:[] as any[]};
 const github={rest:{
  repos:{getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:main?source:base}}})),
   getCommit:vi.fn(async()=>({data:{sha:source,parents:(main?[base]:[base,head]).map(sha=>({sha})),commit:{tree:{sha:'9'.repeat(40)}}}}))},
  pulls:{get:vi.fn(async()=>({data:{number:2440,state:'open',draft:false,
   labels:[{name:'ready-for-ci'},{name:'fast-ci'}],head:{sha:head,ref:'feature/source',repo:repository},
   base:{sha:base,ref:baseRef,repo:repository},merge_commit_sha:source}}))},
  checks:{listForRef:vi.fn(async()=>({data:{check_runs:state.admitted?[check]:[]}}))},
  actions:{getWorkflow:vi.fn(async(args:any)=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:`.github/workflows/${args.workflow_id}`}})),
   getWorkflowRun:vi.fn(async(args:any)=>({data:args.run_id===requester.id?requesterApi:controller})),
   listWorkflowRuns:vi.fn(async(args:any)=>{
    const candidates=args.workflow_id===98?[requester]:[...(state.admitted?[controller]:[]),...state.older];
    const {start,end}=creationBounds(args.created);
    const filtered=candidates.filter(run=>(!args.event||run.event===args.event)&&(!args.branch||run.head_branch===args.branch)&&
     (!args.head_sha||run.head_sha===args.head_sha)&&Date.parse(run.created_at)>=start&&Date.parse(run.created_at)<=end);
    return {data:{workflow_runs:filtered.slice((args.page-1)*100,Math.min(args.page*100,1000))}};
   }),
   listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{id:55,
    name:`dedicated-qualification-${expected.headSha}-${source}-${base}-pr${expected.prNumber}-request30000-1-attempt1`,
    expired:false,size_in_bytes:1024,workflow_run:{id:controller.id}}]}})),
   listJobsForWorkflowRun:vi.fn(async()=>({data:{jobs:[{name:'benchmark',status:'completed',conclusion:'success'}]}}))}
 }};
 pinArtifactFixture(github,check,controller);
 return {github,expected,requester,requesterApi,controller,check,state};
}
const options={maxAttempts:3,admissionAttempts:3,delay:async()=>{}};
describe('authenticated requester lower bound for result discovery',()=>{
 it('waits only for bounded admission when no controller exists amid deep older Main traffic',async()=>{
  const f=fixture();f.state.admitted=false;
  f.state.older=Array.from({length:12000},(_,i)=>({...f.controller,id:29000-i,event:'workflow_run',head_branch:'main',head_sha:pin,
   display_title:'dedicated-refresh-v2 execution=false request=1 title=unrelated',
   created_at:new Date(Date.UTC(2026,9,18,10,0,-i)).toISOString()}));
  const delay=vi.fn(async()=>{});
  await expect(waitForDedicatedResult(f.github,f.expected,{...options,delay})).rejects.toThrow('No Linux controller admitted within the admission window');
  expect(delay).toHaveBeenCalledTimes(2);
  expect(f.github.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  const controllerCalls=f.github.rest.actions.listWorkflowRuns.mock.calls.filter(([args])=>args.workflow_id===99);
  expect(controllerCalls.length).toBeLessThanOrEqual(9);
  expect(controllerCalls.every(([args])=>creationBounds(args.created).start===Date.parse(floor))).toBe(true);
 });
 it.each(['pr','main','stack'] as const)('preserves authenticated %s controller and complete immutable evidence within the requester window',async kind=>{
  const f=fixture(kind);
  await expect(waitForDedicatedResult(f.github,f.expected,options)).resolves.toEqual({runId:f.controller.id,sourceSha:source});
  expect(f.github.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({run_id:f.requester.id}));
  expect(f.github.rest.actions.getWorkflowRun.mock.calls.filter(([args])=>args.run_id===f.requester.id)).toHaveLength(2);
  expect(f.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalled();
  const controllerCalls=f.github.rest.actions.listWorkflowRuns.mock.calls.filter(([args])=>args.workflow_id===99);
  expect(controllerCalls.every(([args])=>creationBounds(args.created).start===Date.parse(floor))).toBe(true);
 });
 it.each([undefined,null,'not-a-date','2026-02-30T00:00:00Z'])('fails closed before history lookup for an invalid actual requester creation date (%j)',async value=>{
  const f=fixture();Object.assign(f.requesterApi,{created_at:value});
  await expect(waitForDedicatedResult(f.github,f.expected,options)).rejects.toThrow();
  expect(f.github.rest.actions.listWorkflowRuns.mock.calls.filter(([args])=>args.workflow_id===99)).toHaveLength(0);
  expect(f.github.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
 });
 it.each([
  {id:30001},{run_attempt:2},{workflow_id:97},{path:'.github/workflows/untrusted.yml'},
  {repository:{full_name:'other/repo'}},{head_repository:{full_name:'other/repo'}},
  {head_sha:'f'.repeat(40)},{display_title:`CI coverage-v1 · ${'f'.repeat(40)}`},
 ])('never derives a search floor from substituted requester identity/source %j',async change=>{
  const f=fixture();Object.assign(f.requesterApi,change);
  await expect(waitForDedicatedResult(f.github,f.expected,options)).rejects.toThrow();
  expect(f.github.rest.actions.listWorkflowRuns.mock.calls.filter(([args])=>args.workflow_id===99)).toHaveLength(0);
  expect(f.github.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
 });
 it.each([{app:{slug:'other-app'}},{summary:{controllerAttempt:2}},{summary:{sourceSha:'e'.repeat(40)}}])(
  'retains issuer, controller-attempt and exact-source checks after bounding discovery (%j)',async change=>{
   const f=fixture();
   if(change.app)f.check.app=change.app;
   if(change.summary)f.check.output.summary=JSON.stringify({...JSON.parse(f.check.output.summary),...change.summary});
   await expect(waitForDedicatedResult(f.github,f.expected,options)).rejects.toThrow();
   expect(f.github.rest.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });
 it.each([{run_attempt:2},{created_at:'2026-10-18T12:00:01Z'},{repository:{full_name:'other/repo'}}])(
  'revalidates actual requester identity and its creation floor after receipt download (%j)',async change=>{
   const f=fixture(),download=f.github.rest.actions.listWorkflowRunArtifacts.getMockImplementation()!;
   f.github.rest.actions.listWorkflowRunArtifacts.mockImplementation(async()=>{
    Object.assign(f.requesterApi,change);return download();
   });
   await expect(waitForDedicatedResult(f.github,f.expected,options)).rejects.toThrow();
   expect(f.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalled();
   expect(f.github.rest.actions.getWorkflowRun.mock.calls.filter(([args])=>args.run_id===f.requester.id)).toHaveLength(2);
  });
 it('revalidates the actual isolated requester origin before accepting its completed receipt',async()=>{
  const f=fixture(),execution='6'.repeat(40),tree='9'.repeat(40);
  const isolated={event:'workflow_dispatch',head_branch:`ci-execution/${pin}`,head_sha:execution,
   display_title:`CI refresh-v1 pr=2440 head=${head} base=${base} merge=${source}`};
  Object.assign(f.requester,isolated);Object.assign(f.requesterApi,isolated);
  f.github.rest.repos.getBranch.mockImplementation(async(args:any)=>({data:{name:args.branch,commit:{sha:args.branch===`ci-execution/${pin}`?execution:pin}}}));
  Object.assign(f.github.rest.repos,{compareCommitsWithBasehead:vi.fn(async({basehead}:any)=>({data:{
   status:basehead.split('...')[0]===basehead.split('...')[1]?'identical':'ahead',merge_base_commit:{sha:basehead.split('...')[0]}}}))});
  Object.assign(f.github.rest,{git:{getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:commit_sha===execution?pin:base}]}}))}});
  const download=f.github.rest.actions.listWorkflowRunArtifacts.getMockImplementation()!;
  f.github.rest.actions.listWorkflowRunArtifacts.mockImplementation(async()=>{
   f.requesterApi.head_sha='0'.repeat(40);return download();
  });
  await expect(waitForDedicatedResult(f.github,{...f.expected,controllerSha:pin},options)).rejects.toThrow(/isolated/i);
  expect(f.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalled();
  expect(f.github.rest.actions.getWorkflowRun.mock.calls.filter(([args])=>args.run_id===f.requester.id)).toHaveLength(2);
 });
});
