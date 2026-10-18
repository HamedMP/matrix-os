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


it.each(['pull_request','isolated-placeholder'])('authenticates genuine %s before dispatching ordinary PR work or skipping the explicit P handoff',async kind=>{
 const f=fixture(`CI coverage-v1 · ${merge}`),execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`;
 Object.assign(f.run,{event:'pull_request',head_branch:'child',head_sha:head,status:'queued',conclusion:null});
 if(kind==='isolated-placeholder')Object.assign(f.run,{event:'workflow_dispatch',head_branch:branch,head_sha:execution,display_title:'CI'});
 f.context.payload.action='requested';
 const github:any=f.github;
 github.rest.repos={getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:args.branch===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async(args:any)=>({data:{sha:args.commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async(args:any)=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:`.github/workflows/${args.workflow_id}`}}));
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:[]}}));
 if(kind==='pull_request'){
  await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:true,mode:'qualification'});
  expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:{controller_mode:'qualification',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'requested'}}));
 }else{
  await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
  expect(github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:execution}));
  expect(github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:pin}));
  expect(github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 }
 expect(f.variables).not.toHaveBeenCalled();
});


it('does not create reconciliation work for ordinary manual Main CI without a PR marker',async()=>{
 const f=fixture(`CI coverage-v1 · ${pin}`);
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();expect(f.variables).not.toHaveBeenCalled();
});

it.each(['requested','completed'])('ignores authenticated ordinary manual branch CI %s without a PR source marker',async action=>{
 const f=fixture(`CI coverage-v1 · ${head}`);
 f.run.head_branch='codex/test-only';f.run.head_sha=head;f.context.payload.action=action;
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.getWorkflowRun).toHaveBeenCalled();expect(f.github.rest.actions.getWorkflow).toHaveBeenCalled();
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
});
it.each(['repository','workflow-id','workflow-path','head-repository'])('does not hide an unauthenticated manual branch %s behind no-op',async kind=>{
 const f=fixture(`CI coverage-v1 · ${head}`);f.run.head_branch='codex/test-only';f.run.head_sha=head;
 if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
 if(kind==='workflow-id')f.run.workflow_id=99;if(kind==='workflow-path')f.run.path='.github/workflows/other.yml';
 if(kind==='head-repository')f.run.head_repository.full_name='attacker/matrix-os';
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow();
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it.each(['CI refresh-v1 pr=2454','CI hosted-refresh-v1 pr=not-a-number'])('rejects malformed claimed refresh rather than ordinary manual no-op: %s',async title=>{
 const f=fixture(title);f.run.head_branch='codex/test-only';f.run.head_sha=head;
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow();
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it('stands down a stale manual branch attempt before considering no-op',async()=>{
 const f=fixture(`CI coverage-v1 · ${head}`);f.run.head_branch='codex/test-only';f.run.head_sha=head;
 f.context.payload.workflow_run={...f.run,run_attempt:1};f.run.run_attempt=2;
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false,stale:true});
 expect(f.github.rest.actions.getWorkflow).toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
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

function isolatedRerunFixture(hosted=false){
 const execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`;
 const title=`CI ${hosted?'hosted-refresh-v1':'refresh-v1'} pr=2454 head=${head} base=${base} merge=${merge}`;
 const f=fixture(title),github:any=f.github;
 Object.assign(f.run,{run_attempt:2,head_branch:branch,head_sha:execution,status:'in_progress',conclusion:null});
 f.context.payload.action='in_progress';
 github.rest.repos={getBranch:vi.fn(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:requested===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:`.github/workflows/${workflow_id}`}}));
 const child=(mode:string,attempt:number)=>({...f.run,id:900+attempt,run_attempt:1,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',display_title:`dedicated-isolated-v1 mode=${mode} request=321 attempt=${attempt}`});
 const rows:any[]=[child('qualification',1)];
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:rows}}));
 github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:1,jobs:[{name:'CI Results',steps:[{name:'Summarize required CI jobs',status:'completed',conclusion:'success'}]}]}});
 return{...f,github,branch,execution,tree,rows,child};
}

describe('automatic isolated events preserve explicit handoffs and terminal recovery',()=>{
 it.each([1,2].flatMap(attempt=>['in_progress','completed'].flatMap(action=>[false,true].map(hosted=>({attempt,action,hosted})))))('authenticates then ignores active or already handed-off P attempt $attempt $action (hosted=$hosted)',async({attempt,action,hosted})=>{
  const f=isolatedRerunFixture(hosted);f.run.run_attempt=attempt;f.context.payload.action=action;
  if(action==='completed'){
   Object.assign(f.run,{status:'completed',conclusion:'success'});
   f.rows.push(f.child('reconcile',attempt));
  }
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual(action==='completed'?{dispatched:false,runId:900+attempt,runAttempt:1}:{dispatched:false});
  expect(f.github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:f.execution}));
  expect(f.github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:pin}));
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each([
  {attempt:1,conclusion:'cancelled',hosted:false},
  {attempt:1,conclusion:'failure',hosted:false},
  {attempt:2,conclusion:'failure',hosted:false},
  {attempt:2,conclusion:'success',hosted:false},
  {attempt:1,conclusion:'timed_out',hosted:false},
  {attempt:2,conclusion:'cancelled',hosted:true},
 ])('recovers terminal P attempt $attempt $conclusion without an explicit completion (hosted=$hosted)',async({attempt,conclusion,hosted})=>{
  const f=isolatedRerunFixture(hosted);
  Object.assign(f.run,{run_attempt:attempt,status:'completed',conclusion});f.context.payload.action='completed';
  // A prior attempt's explicit completion must not suppress the current one.
  if(attempt===2)f.rows.push(f.child('reconcile',1));
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual({dispatched:true,mode:'reconcile'});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
   workflow_id:'ci-dedicated.yml',ref:f.branch,
   inputs:{controller_mode:'reconcile',requesting_run_id:'321',requesting_run_attempt:String(attempt),requesting_action:'completed',reconciliation_pr:'2454'},
  }));
  expect(f.github.rest.actions.createWorkflowDispatch.mock.calls.every(([args]:any[])=>args.inputs.controller_mode!=='qualification')).toBe(true);
  expect(f.github.rest.actions.getWorkflowRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.variables).not.toHaveBeenCalled();
 });
 it.each(['action_required','stale','startup_failure','neutral','skipped'])('accepts real terminal conclusion %s only for reconciliation',async conclusion=>{
  const f=isolatedRerunFixture();Object.assign(f.run,{status:'completed',conclusion});f.context.payload.action='completed';
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual({dispatched:true,mode:'reconcile'});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({inputs:expect.objectContaining({controller_mode:'reconcile'})}));
 });
 it.each(['active','missing-conclusion','invalid-conclusion','malformed-marker','hosted-malformed-marker'])('rejects terminal P fallback with %s before dispatch',async kind=>{
  const f=isolatedRerunFixture(kind==='hosted-malformed-marker');
  Object.assign(f.run,{status:'completed',conclusion:'failure'});f.context.payload.action='completed';
  if(kind==='active')Object.assign(f.run,{status:'in_progress',conclusion:null});
  if(kind==='missing-conclusion')f.run.conclusion=null;
  if(kind==='invalid-conclusion')f.run.conclusion='unknown-result';
  if(kind==='malformed-marker')f.run.display_title='CI refresh-v1 pr=2454';
  if(kind==='hosted-malformed-marker')f.run.display_title='CI hosted-refresh-v1 pr=2454';
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['CI',`CI coverage-v1 · ${head}`])('keeps completed ordinary P manual title %s a benign no-op after origin authentication',async title=>{
  const f=isolatedRerunFixture();Object.assign(f.run,{status:'completed',conclusion:'success',display_title:title});f.context.payload.action='completed';
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual({dispatched:false});
  expect(f.github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:f.execution}));
  expect(f.github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:pin}));
  expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('does not reconcile when the actual requester advances during terminal scope validation',async()=>{
  const f=isolatedRerunFixture();Object.assign(f.run,{status:'completed',conclusion:'failure'});f.context.payload.action='completed';
  f.github.rest.actions.getWorkflowRun.mockResolvedValueOnce({data:{...f.run}}).mockResolvedValue({data:{...f.run,run_attempt:3,status:'queued',conclusion:null}});
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['repository','workflow','path','foreign-head','tree','parent','invalid-attempt'].flatMap(kind=>['in_progress','completed'].map(action=>({kind,action}))))('cannot hide spoofed $kind behind automatic P $action handling',async({kind,action})=>{
  const f=isolatedRerunFixture();
  f.context.payload.action=action;if(action==='completed')Object.assign(f.run,{status:'completed',conclusion:'failure'});
  if(kind==='repository')f.run.repository.full_name='attacker/matrix-os';
  if(kind==='workflow')f.run.workflow_id=99;if(kind==='path')f.run.path='.github/workflows/other.yml';
  if(kind==='foreign-head')f.run.head_repository.full_name='attacker/matrix-os';
  if(kind==='tree')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:commit_sha===f.execution?'0'.repeat(40):f.tree},parents:[{sha:pin}]}}));
  if(kind==='parent')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:f.tree},parents:[{sha:base}]}}));
  if(kind==='invalid-attempt')f.run.run_attempt=0;
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('does not turn a malformed source marker in an automatic event into qualification authority',async()=>{
  const f=isolatedRerunFixture();f.run.display_title='CI refresh-v1 pr=2454';
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual({dispatched:false});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('stands down an older event after actual requester attempt advances',async()=>{
  const f=isolatedRerunFixture();f.context.payload.workflow_run={...f.run,run_attempt:1};
  expect(await routeControllerEvent(f.github,repo,pin,f.context,snapshot)).toEqual({dispatched:false,stale:true});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
});
