import {describe,expect,it,vi} from 'vitest';
import {routeControllerEvent,routeManualCi} from '../../scripts/ci/dedicated-execution-router.mjs';
import {InactiveIsolatedRequester,isolatedTrigger,validatedIsolatedReconciliationScope} from '../../scripts/ci/dedicated-isolated.mjs';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
const pin='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),merge='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'},snapshot={pin,flag:'true'};
function fixture(title:string){
 const run={id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_branch:'main',head_sha:pin,status:'completed',conclusion:'success',display_title:title,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const variables=vi.fn(async()=>{throw new Error('GITHUB_TOKEN has no Variables read authority');});
 const github={rest:{actions:{listRepoVariables:variables,getRepoVariable:variables,getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),getWorkflowRun:vi.fn(async()=>({data:run})),listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[{name:'CI Results',steps:[{name:'Summarize isolated CI routing',status:'completed',conclusion:'success'}]}]}})),createWorkflowDispatch:vi.fn()},pulls:{get:vi.fn(async()=>({data:{state:'open',draft:false,head:{sha:'f'.repeat(40)},base:{ref:'main',sha:base}}}))}}};
 return{github,variables,run,context:{eventName:'workflow_run',ref:'refs/heads/main',payload:{action:'completed',workflow_run:run}}};
}
describe('secret-free isolated Main routers',()=>{
 it('does not create reconciliation work for a Main routing-only run',async()=>{
  const f=fixture(`CI routing-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toMatchObject({dispatched:false});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rejects coverage from a routing-only rerun even when its historical title remains a refresh marker',async()=>{
  const f=fixture(`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toMatchObject({dispatched:false});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('benignly skips a superseded manual request using protected vars without attempting the Variables API',async()=>{
  const f=fixture('CI');
  await expect(routeManualCi(f.github,repo,pin,{pr_number:'2454',head_sha:head,base_sha:base,source_sha:merge},snapshot)).resolves.toEqual({routed:true,stale:true});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rejects a disabled or inconsistent protected router snapshot before reading a requester',async()=>{
  for(const config of [{pin,flag:'false'},{pin:base,flag:'true'}]){
   const f=fixture('CI');await expect(routeControllerEvent(f.github,repo,pin,f.context,config)).rejects.toThrow();
   expect(f.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();expect(f.variables).not.toHaveBeenCalled();
  }
 });
});


it.each(['pull_request','isolated-placeholder'])('routes genuine %s execution to the proved distinct commit without Variables API access',async kind=>{
 const f=fixture(`CI coverage-v1 · ${merge}`),execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`;
 Object.assign(f.run,{event:'pull_request',head_branch:'child',head_sha:head,status:'queued',conclusion:null});
 if(kind==='isolated-placeholder')Object.assign(f.run,{event:'workflow_dispatch',head_branch:branch,head_sha:execution,display_title:'CI'});
 f.context.payload.action='requested';
 const github:any=f.github;
 github.rest.repos={getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:args.branch===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async(args:any)=>({data:{sha:args.commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async(args:any)=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:`.github/workflows/${args.workflow_id}`}}));
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:[]}}));
 await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:true,mode:'qualification'});
 expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:{controller_mode:'qualification',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'requested'}}));
 expect(f.variables).not.toHaveBeenCalled();
});


it('does not create reconciliation work for ordinary manual Main CI without a PR marker',async()=>{
 const f=fixture(`CI coverage-v1 · ${pin}`);
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();expect(f.variables).not.toHaveBeenCalled();
});

it.each(['requested','completed'])('benignly ignores an authenticated fork PR %s event without dispatching work',async action=>{
 const f=fixture(`CI coverage-v1 · ${merge}`);
 Object.assign(f.run,{event:'pull_request',head_branch:'fork-feature',head_sha:head,head_repository:{full_name:'contributor/matrix-os'}});
 f.context.payload.action=action;
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 expect(f.variables).not.toHaveBeenCalled();
});

it.each(['base-repository','workflow-id','workflow-path','manual-event','push-event','missing-head','malformed-head'])('does not use the fork no-op to hide %s authentication failure',async kind=>{
 const f=fixture(`CI coverage-v1 · ${merge}`);
 Object.assign(f.run,{event:'pull_request',head_repository:{full_name:'contributor/matrix-os'}});
 if(kind==='base-repository')f.run.repository.full_name='attacker/matrix-os';
 if(kind==='workflow-id')f.run.workflow_id=99;
 if(kind==='workflow-path')f.run.path='.github/workflows/untrusted.yml';
 if(kind==='manual-event')f.run.event='workflow_dispatch';
 if(kind==='push-event')f.run.event='push';
 if(kind==='missing-head')f.run.head_repository.full_name='';
 if(kind==='malformed-head')f.run.head_repository.full_name='not-a-repository';
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow('Untrusted controller bridge requester');
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

const isolatedInputs={controller_mode:'qualification',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'requested'};
it.each(['finished','rerun'])('identifies an authenticated %s isolated qualification requester as inactive',async kind=>{
 const f=fixture(`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
 if(kind==='rerun'){f.run.run_attempt=2;f.run.status='queued';}
 await expect(isolatedTrigger(f.github,repo,isolatedInputs,'qualification')).rejects.toBeInstanceOf(InactiveIsolatedRequester);
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it.each(['future-attempt','repository','workflow','run-id','invalid-attempt'])('does not classify unauthenticated %s as an inactive requester',async kind=>{
 const f=fixture(`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
 const inputs={...isolatedInputs};
 if(kind==='future-attempt'){inputs.requesting_run_attempt='2';inputs.requesting_action='in_progress';}
 if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
 if(kind==='workflow')f.run.workflow_id=99;if(kind==='run-id')f.run.id=322;if(kind==='invalid-attempt')f.run.run_attempt=0;
 let error:unknown;try{await isolatedTrigger(f.github,repo,inputs,'qualification');}catch(caught){error=caught;}
 expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(InactiveIsolatedRequester);
});
it('retains exact active qualification requester identity without changing its source',async()=>{
 const f=fixture(`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`);f.run.status='queued';
 expect(await isolatedTrigger(f.github,repo,isolatedInputs,'qualification')).toEqual({action:'requested',workflow_run:f.run});
});

function scopeFixture(prNumber:number){
 const f=fixture(`CI coverage-v1 · ${merge}`),url='https://api.github.com/repos/HamedMP/matrix-os';
 Object.assign(f.run,{event:'pull_request',pull_requests:[{number:prNumber,head:{repo:{url}},base:{repo:{url}}}]});
 const inputs={controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'completed',reconciliation_pr:String(prNumber)};
 return{...f,inputs};
}
it.each([2454,2455])('derives reconciliation queue scope %s from authenticated requester data',async prNumber=>{
 const f=scopeFixture(prNumber);
 expect(await validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).toEqual({prNumber});
});
it.each([2454,2455])('the actual router carries authenticated PR %s into its isolated queue hint',async prNumber=>{
 const f=scopeFixture(prNumber),execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`,github:any=f.github;
 github.rest.repos={getBranch:vi.fn(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:requested===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:`.github/workflows/${workflow_id}`}}));
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:[]}}));
 github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:0,jobs:[]}});
 await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:true,mode:'reconcile'});
 expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ref:branch,inputs:expect.objectContaining({controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',reconciliation_pr:String(prNumber)})}));
});
it.each(['','0','2455','02454','bad','1000000'])('rejects an unbound reconciliation queue hint %j before work',async hint=>{
 const f=scopeFixture(2454);f.inputs.reconciliation_pr=hint;
 await expect(validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).rejects.toThrow('Invalid isolated reconciliation scope hint');
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it('keeps authenticated Main completion in the full maintenance scope',async()=>{
 const f=scopeFixture(2454);Object.assign(f.run,{event:'push',head_branch:'main'});f.inputs.reconciliation_pr='0';
 expect(await validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).toEqual({});
 f.inputs.reconciliation_pr='2454';await expect(validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).rejects.toThrow('Invalid isolated reconciliation scope hint');
});

function ambiguousScopeFixture(count:number){
 const f=scopeFixture(2454),url='https://api.github.com/repos/HamedMP/matrix-os';
 Object.assign(f.run,{pull_requests:Array.from({length:count},(_,index)=>({number:2454+index,head:{repo:{url}},base:{repo:{url}}}))});
 f.inputs.reconciliation_pr='0';return f;
}
it.each([0,2])('preserves an authenticated completion with %s PR associations as full scope and rejects a forged hint',async count=>{
 const f=ambiguousScopeFixture(count);
 expect(await validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).toEqual({});
 f.inputs.reconciliation_pr='2454';
 await expect(validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).rejects.toThrow('Invalid isolated reconciliation scope hint');
});
it.each([0,2])('the actual router dispatches full scope for %s PR associations',async count=>{
 const f=ambiguousScopeFixture(count),execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`,github:any=f.github;
 github.rest.repos={getBranch:vi.fn(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:requested===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:`.github/workflows/${workflow_id}`}}));
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:[]}}));
 github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:0,jobs:[]}});
 await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:true,mode:'reconcile'});
 expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
 expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ref:branch,inputs:{controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'completed',reconciliation_pr:'0'}}));
});
it.each(['repository','workflow','attempt'])('full-scan ambiguity cannot bypass requester %s authentication',async kind=>{
 const f=ambiguousScopeFixture(2);
 if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
 if(kind==='workflow')f.run.workflow_id=99;
 if(kind==='attempt')f.run.run_attempt=2;
 await expect(validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).rejects.toThrow();
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it.each(['non-array','invalid-id','foreign-head','foreign-base'])('does not hide malformed %s PR scope with a full scan',async kind=>{
 const f=scopeFixture(2454),rows:any=(f.run as any).pull_requests;
 if(kind==='non-array')Object.assign(f.run,{pull_requests:{}});
 if(kind==='invalid-id')rows[0].number=0;
 if(kind==='foreign-head')rows[0].head.repo.url='https://api.github.com/repos/attacker/matrix-os';
 if(kind==='foreign-base')rows[0].base.repo.url='https://api.github.com/repos/attacker/matrix-os';
 f.inputs.reconciliation_pr='0';
 await expect(validatedIsolatedReconciliationScope(f.github,repo,f.inputs)).rejects.toThrow('Completed requester has no authenticated PR scope');
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

it('uses independent PR queue keys and revalidates hints before App credentials',()=>{
 const job=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8')).jobs.reconcile;
 const expression=job.concurrency.group.match(/\$\{\{([\s\S]*?)\}\}/)[1];
 const key=(pr:string,mode='reconcile')=>new Function('github','inputs','format',`return (${expression});`)(
  {event_name:'workflow_dispatch',event:{workflow_run:{pull_requests:[]}}},{controller_mode:mode,reconciliation_pr:pr},
  (value:string,...args:unknown[])=>value.replace(/\{(\d+)\}/g,(_match:string,index:string)=>String(args[Number(index)])));
 expect(key('2454')).toBe('pr-2454');expect(key('2455')).toBe('pr-2455');expect(key('0')).toBe('full');expect(key('0','maintenance')).toBe('full');
 const names=job.steps.map((step:any)=>step.name),guard=names.indexOf('Revalidate isolated queue scope before credentials');
 expect(guard).toBeGreaterThan(names.indexOf('Authenticate default-main reconciliation source'));
 expect(guard).toBeGreaterThan(job.steps.findIndex((step:any)=>step.uses?.startsWith('actions/checkout@')));
 expect(guard).toBeLessThan(names.indexOf('Create repository-scoped configuration read token'));
 expect(guard).toBeLessThan(names.indexOf('Create repository-scoped checks-only gate token'));
 expect(job.steps[guard].with.script).toContain('validatedIsolatedReconciliationScope');
 expect(job.concurrency['cancel-in-progress']).toBe(false);
});

it('the actual admission script stands down authenticated inactive requesters but rejects a future attempt',()=>{
 const workflow=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
 const script=workflow.jobs.benchmark.steps.find((step:any)=>step.name==='Admit current source head').with.script;
 const program=`
 import {createRequire} from 'node:module';import assert from 'node:assert/strict';
 const pin=${JSON.stringify(pin)},execution='e'.repeat(40),tree='f'.repeat(40),ref='refs/heads/ci-execution/'+pin;
 const event={id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_sha:pin,head_branch:'main',status:'completed',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const github={rest:{actions:{getWorkflow:async()=>({data:{id:98,path:'.github/workflows/ci.yml'}}),getWorkflowRun:async()=>({data:event})},
 repos:{getBranch:async({branch})=>({data:{name:branch,commit:{sha:branch==='main'?pin:execution}}}),compareCommitsWithBasehead:async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}})},
 git:{getCommit:async({commit_sha})=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}})}}};
 const origin={schemaVersion:1,controllerSha:pin,controllerRef:'refs/heads/main',executionRef:ref,executionSha:execution,executionWorkflowSha:execution,workflowPath:'.github/workflows/ci-dedicated.yml',treeSha:tree};
 const inputs=${JSON.stringify(isolatedInputs)},context={repo:${JSON.stringify(repo)},eventName:'workflow_dispatch',ref,sha:execution,payload:{inputs},runId:999};
 const env={GITHUB_WORKSPACE:process.cwd(),CONTROLLER_SHA:pin,CONTROLLER_WORKFLOW_REF:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@'+ref,EXECUTION_WORKFLOW_SHA:execution,EXECUTION_ORIGIN:JSON.stringify(origin),RACE_LOST_ERRORS:'[]'};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor,body=${JSON.stringify(script)},outputs={};
 const run=()=>new AsyncFunction('github','context','core','require','process',body)(github,context,{notice(){},setOutput(key,value){outputs[key]=value;}},createRequire(import.meta.url),{env});
 await run();assert.equal(outputs.admitted,'false');delete outputs.admitted;
 event.run_attempt=2;event.status='queued';await run();assert.equal(outputs.admitted,'false');delete outputs.admitted;
 event.run_attempt=1;inputs.requesting_run_attempt='2';inputs.requesting_action='in_progress';await assert.rejects(run());assert.equal(outputs.admitted,undefined);
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:10000,env:{...process.env,GITHUB_WORKSPACE:process.cwd()}});
 expect(result.status,result.stderr).toBe(0);
});
