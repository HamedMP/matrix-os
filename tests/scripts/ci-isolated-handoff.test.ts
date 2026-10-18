import {describe,expect,it,vi} from 'vitest';
import {routeControllerEvent} from '../../scripts/ci/dedicated-execution-router.mjs';

const repo={owner:'HamedMP',repo:'matrix-os'},pin='a'.repeat(40),execution='e'.repeat(40),tree='f'.repeat(40);
const head='b'.repeat(40),base='c'.repeat(40),source='d'.repeat(40),branch=`ci-execution/${pin}`;
const inputs={execution_mode:'linux',pr_number:'2454',head_sha:head,base_sha:base,source_sha:source};
const configuration={pin,flag:'true',imageDigest:'sha256:'+'1'.repeat(64),harnessDigest:'2'.repeat(64),linuxRequired:true,backendAttempt:1};
const module=()=>import('../../scripts/ci/dedicated-ci-handoff.mjs');
function fixture(){
 const run={id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_branch:branch,head_sha:execution,status:'in_progress',conclusion:null as string|null,
  display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${source}`,repository:{id:1157069949,full_name:'HamedMP/matrix-os'},head_repository:{id:1157069949,full_name:'HamedMP/matrix-os'}};
 const pull={number:2454,state:'open',draft:false,head:{sha:head,ref:'feature',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'main',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:source,labels:[{name:'ready-for-ci'},{name:'fast-ci'}]};
 const github:any={rest:{actions:{
  getWorkflow:vi.fn(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:`.github/workflows/${workflow_id}`}})),
  getWorkflowRun:vi.fn(async()=>({data:run})),
  listWorkflowRuns:vi.fn(async()=>({data:{total_count:0,workflow_runs:[]}})),
  listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[{id:401,name:'Isolated CI Backend Decision',run_id:run.id,run_attempt:run.run_attempt,head_sha:run.head_sha,head_branch:run.head_branch,status:'completed',conclusion:'success'}]}})),
  createWorkflowDispatch:vi.fn(async()=>({status:204})),
  createWorkflowDispatchEvent:vi.fn(),
 },repos:{
  getBranch:vi.fn(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:requested===branch?execution:pin}}})),
  getCommit:vi.fn(async({ref}:any)=>({data:{sha:ref,parents:[{sha:base},{sha:head}],commit:{tree:{sha:tree}}}})),
  compareCommitsWithBasehead:vi.fn(async({basehead}:any)=>({data:{status:'ahead',merge_base_commit:{sha:basehead.split('...')[0]}}})),
 },git:{getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))},
 pulls:{get:vi.fn(async()=>({data:pull}))},apps:{createInstallationAccessToken:vi.fn()}}};
 const context={eventName:'workflow_dispatch',ref:`refs/heads/${branch}`,sha:execution,workflowRef:`HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/${branch}`,workflowSha:execution,runId:321,runAttempt:1,payload:{inputs,repository:{id:1157069949,full_name:'HamedMP/matrix-os'}}};
 return{github,run,pull,context};
}

describe('explicit isolated CI handoff without workflow_run delivery',()=>{
 it.each([1,2])('dispatches qualification for the authenticated self attempt %s without waiting for CI completion',async attempt=>{
  const f=fixture();f.run.run_attempt=attempt;f.context.runAttempt=attempt;
  const result=await(await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,inputs,configuration);
  expect(result).toMatchObject({dispatched:true});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:expect.objectContaining({controller_mode:'qualification',requesting_run_id:'321',requesting_run_attempt:String(attempt),requesting_action:attempt===1?'requested':'in_progress'})}));
  expect(f.run.status).toBe('in_progress');expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it.each(['repository','workflow-id','workflow-path','run-id','attempt','event','execution-sha','workflow-sha','workflow-ref','tree','parent','branch','source','disabled','pin'])('does not dispatch qualification for spoofed %s',async kind=>{
  const f=fixture(),actualInputs={...inputs},config={...configuration};
  if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
  if(kind==='workflow-id')f.run.workflow_id=99;
  if(kind==='workflow-path')f.run.path='.github/workflows/untrusted.yml';
  if(kind==='run-id')f.run.id=322;
  if(kind==='attempt')f.run.run_attempt=2;
  if(kind==='event')f.run.event='pull_request';
  if(kind==='execution-sha')f.run.head_sha='0'.repeat(40);
  if(kind==='workflow-sha')f.context.workflowSha=pin;
  if(kind==='workflow-ref')f.context.workflowRef='HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/main';
  if(kind==='tree')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:commit_sha===execution?'0'.repeat(40):tree},parents:[{sha:pin}]}}));
  if(kind==='parent')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:base}]}}));
  if(kind==='branch')f.github.rest.repos.getBranch.mockImplementation(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:pin}}}));
  if(kind==='source')f.github.rest.repos.getCommit.mockImplementation(async({ref}:any)=>({data:{sha:ref,parents:[{sha:base},{sha:execution}],commit:{tree:{sha:tree}}}}));
  if(kind==='disabled')config.flag='false';if(kind==='pin')config.pin=base;
  await expect((await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,actualInputs,config)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('does not request Linux qualification for an authenticated hosted-only refresh',async()=>{
  const f=fixture(),hosted={...inputs,execution_mode:'hosted-only'};
  f.run.display_title=`CI hosted-refresh-v1 pr=2454 head=${head} base=${base} merge=${source}`;
  expect(await(await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,hosted,configuration)).toMatchObject({dispatched:false});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('authenticates but does not dispatch Linux qualification for hosted/docs work',async()=>{
  const f=fixture();
  expect(await(await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,inputs,{...configuration,linuxRequired:false})).toEqual({dispatched:false});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rejects non-boolean qualification routing before a dispatch',async()=>{
  const f=fixture();
  await expect((await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,inputs,{...configuration,linuxRequired:'true'})).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('hands completion to a distinct settling run, never a fabricated completed requester',async()=>{
  const f=fixture();
  expect(await(await module()).requestIsolatedCiCompletion(f.github,repo,f.context,pin,inputs,{...configuration,linuxRequired:false})).toMatchObject({dispatched:true});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:expect.objectContaining({controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'settling',reconciliation_pr:'2454'})}));
  expect(f.run.status).toBe('in_progress');expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it('does not let a stale source request enqueue completion reconciliation',async()=>{
  const f=fixture();f.pull.head.sha='0'.repeat(40);
  await expect((await module()).requestIsolatedCiCompletion(f.github,repo,f.context,pin,inputs,configuration)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['repository','attempt','origin'])('does not let completion handoff bypass %s authentication',async kind=>{
  const f=fixture();
  if(kind==='repository')f.run.head_repository.full_name='attacker/matrix-os';
  if(kind==='attempt')f.run.run_attempt=2;if(kind==='origin')f.context.workflowSha=pin;
  await expect((await module()).requestIsolatedCiCompletion(f.github,repo,f.context,pin,inputs,configuration)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('does not automatically retry an ambiguous qualification dispatch failure',async()=>{
  const f=fixture();f.github.rest.actions.createWorkflowDispatch.mockRejectedValue(new Error('synthetic transport outcome unknown'));
  await expect((await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,inputs,configuration)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
 });
 it('reconciles an authenticated automatic P completion when explicit completion is missing',async()=>{
  const f=fixture();f.run.status='completed';f.run.conclusion='success';
  expect(await routeControllerEvent(f.github,repo,pin,{ref:'refs/heads/main',eventName:'workflow_run',payload:{action:'completed',workflow_run:f.run}},configuration)).toEqual({dispatched:true,mode:'reconcile'});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:{controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'completed',reconciliation_pr:'2454'}}));
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
});

const settling={controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'settling',reconciliation_pr:'2454'};
describe('terminal requester fence before reconciliation credentials',()=>{
 it.each(['success','failure','cancelled'])('waits for actual terminal %s without converting its conclusion to coverage',async conclusion=>{
  const f=fixture();let ticks=0;
  const delay=vi.fn(async()=>{ticks+=1000;f.run.status='completed';f.run.conclusion=conclusion;});
  const result=await(await module()).awaitTerminalIsolatedRequester(f.github,repo,settling,{maxMilliseconds:180000,delay,now:()=>ticks});
  expect(delay).toHaveBeenCalledTimes(1);expect(result).toEqual({action:'completed',workflow_run:f.run});
  expect(result.workflow_run.conclusion).toBe(conclusion);expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it.each(['repository','workflow','attempt','origin','hint'])('rejects %s mismatch before waiting or using App credentials',async kind=>{
  const f=fixture(),value={...settling},delay=vi.fn();
  if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
  if(kind==='workflow')f.run.workflow_id=99;if(kind==='attempt')f.run.run_attempt=2;
  if(kind==='origin')f.run.head_sha=pin;if(kind==='hint')value.reconciliation_pr='2455';
  await expect((await module()).awaitTerminalIsolatedRequester(f.github,repo,value,{maxMilliseconds:180000,delay,now:()=>0})).rejects.toThrow();
  expect(delay).not.toHaveBeenCalled();expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it('fails closed when the requester reruns while settling',async()=>{
  const f=fixture();let ticks=0;
  const delay=vi.fn(async()=>{ticks+=1000;f.run.run_attempt=2;});
  await expect((await module()).awaitTerminalIsolatedRequester(f.github,repo,settling,{maxMilliseconds:180000,delay,now:()=>ticks})).rejects.toThrow();
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it('has an absolute terminal wait bound and cannot admit a still-running requester',async()=>{
  const f=fixture();let ticks=0;const delay=vi.fn(async()=>{ticks+=1000;});
  await expect((await module()).awaitTerminalIsolatedRequester(f.github,repo,settling,{maxMilliseconds:1000,delay,now:()=>ticks})).rejects.toThrow();
  expect(delay.mock.calls.length).toBeLessThanOrEqual(1);expect(f.run.status).toBe('in_progress');
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it('does not start later origin reads once a nested read exhausts the absolute deadline',async()=>{
  const f=fixture();let ticks=0;
  f.github.rest.repos.getBranch.mockImplementation(async({branch:requested}:any)=>{
   ticks=1001;return{data:{name:requested,commit:{sha:execution}}};
  });
  await expect((await module()).awaitTerminalIsolatedRequester(f.github,repo,settling,{maxMilliseconds:1000,now:()=>ticks})).rejects.toThrow();
  expect(f.github.rest.git.getCommit).not.toHaveBeenCalled();
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it('passes the absolute abort signal to a slow nested origin read',async()=>{
  const f=fixture();let observed:AbortSignal|undefined;
  f.github.rest.repos.getBranch.mockImplementation(({request}:any)=>new Promise((_resolve,reject)=>{
   observed=request.signal;
   if(!observed){reject(new Error('Missing absolute deadline signal'));return;}
   observed.addEventListener('abort',()=>reject(observed?.reason),{once:true});
  }));
  await expect((await module()).awaitTerminalIsolatedRequester(f.github,repo,settling,{maxMilliseconds:1000})).rejects.toThrow();
  expect(observed).toBeInstanceOf(AbortSignal);expect(observed?.aborted).toBe(true);
  expect(f.github.rest.git.getCommit).not.toHaveBeenCalled();
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
});
