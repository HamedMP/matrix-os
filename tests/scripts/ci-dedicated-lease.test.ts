import {describe,expect,it,vi} from 'vitest';
import * as helpers from '../../scripts/ci/dedicated-admission.mjs';
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),controller='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'};
function fixture(){
 const pull={number:2454,state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'ci-linux'}],head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'stack/parent',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge};
 const request={repository:'HamedMP/matrix-os',prNumber:2454,headSha:head,baseSha:base,baseRef:'stack/parent',mergeSha:merge,mergeParents:[base,head],requestingRunId:321,requestingRunAttempt:1,controllerRunId:123,controllerRunAttempt:1,controllerSha:controller,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'delegated',suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
 const controllerRun={id:123,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',event:'pull_request_target',run_attempt:1,status:'in_progress',conclusion:null as string|null,head_sha:head,head_branch:'child',display_title:`dedicated-ci-v2 pr=2454 head=${head} base=${base} requested=true`,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const ciRun={...controllerRun,display_title:`CI coverage-v1 · ${merge}`,id:321,workflow_id:98,path:'.github/workflows/ci.yml',event:'pull_request',pull_requests:[{number:2454,head:{sha:head,ref:'child'},base:{sha:base,ref:'stack/parent'}}]};
 const github={rest:{git:{getRef:vi.fn(async(args:{ref:string})=>({data:{object:{sha:args.ref==='heads/main'?merge:base}}}))},pulls:{get:vi.fn(async()=>({data:pull}))},repos:{compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'ahead',merge_base_commit:{sha:controller}}})),getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))},actions:{getWorkflow:vi.fn(async(args:{workflow_id:string})=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:'.github/workflows/'+args.workflow_id}})),getWorkflowRun:vi.fn(async(args:{run_id:number})=>({data:args.run_id===123?controllerRun:ciRun})),listWorkflowRuns:vi.fn(async(args:{workflow_id:number})=>({data:{workflow_runs:args.workflow_id===99?[controllerRun]:[ciRun]}})),getRepoVariable:vi.fn(async(args:{name:string})=>({data:{name:args.name,value:args.name==='MATRIX_CI_CONTROLLER_SHA'?controller:args.name==='MATRIX_CI_RUNNER_IMAGE_DIGEST'?request.imageDigest:args.name==='MATRIX_CI_RUNNER_HARNESS_DIGEST'?request.harnessDigest:'true'}}))}}};
 const origin={sha:controller,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
 const reviewed={rest:{...github.rest,actions:{...github.rest.actions,listRepoVariables:vi.fn(async()=>({data:{total_count:5,variables:await Promise.all(['MATRIX_CI_CONTROLLER_SHA','MATRIX_CI_DEDICATED_ENABLED','MATRIX_CI_DEDICATED_SHADOW','MATRIX_CI_RUNNER_IMAGE_DIGEST','MATRIX_CI_RUNNER_HARNESS_DIGEST'].map(async name=>(await github.rest.actions.getRepoVariable({name})).data))}}))}}};
 return{github:reviewed,pull,request,controllerRun,ciRun,origin};
}
async function verify(f:ReturnType<typeof fixture>){const fn=(helpers as Record<string,unknown>).verifyDedicatedLeaseGrant as Function;expect(fn).toBeTypeOf('function');return fn(f.github,repo,f.origin,f.request);}
describe('authenticated post-lock grants and renewals',()=>{
 it('allows an exact live stacked tuple only after authenticated requesting/controller run checks',async()=>{const f=fixture();await verify(f);expect(f.github.rest.repos.getCommit).toHaveBeenCalled();expect(f.github.rest.actions.getWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({run_id:321,request:{timeout:10000}}));});
 it.each(['ready-for-ci','ci-linux'])('denies removed %s before a grant',async label=>{const f=fixture();f.pull.labels=f.pull.labels.filter(x=>x.name!==label);await expect(verify(f)).rejects.toThrow(/stale|admission/);});
 it.each(['head','base','merge','ref','draft','closed'])('denies stale %s after host lock',async field=>{const f=fixture();if(field==='head')f.pull.head.sha=merge;if(field==='base')f.pull.base.sha=merge;if(field==='merge')f.pull.merge_commit_sha=head;if(field==='ref')f.pull.base.ref='retargeted';if(field==='draft')f.pull.draft=true;if(field==='closed')f.pull.state='closed';await expect(verify(f)).rejects.toThrow(/stale|admission/);});
 it('denies wrong ordered merge parents even with matching API SHA',async()=>{const f=fixture();f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:merge,parents:[{sha:head},{sha:base}]}});await expect(verify(f)).rejects.toThrow(/parents/);});
 it.each(['attempt','cancelled','definition','candidate','snapshot'])('denies requesting CI %s mismatch',async kind=>{const f=fixture();if(kind==='attempt')f.ciRun.run_attempt=2;if(kind==='cancelled'){f.ciRun.status='completed';f.ciRun.conclusion='cancelled';}if(kind==='definition')f.ciRun.workflow_id=99;if(kind==='candidate')f.ciRun.head_sha=base;if(kind==='snapshot')f.ciRun.pull_requests[0].base.sha=merge;await expect(verify(f)).rejects.toThrow(/requesting|CI/);});
 it.each(['attempt','cancelled','definition','candidate'])('denies controller %s mismatch',async kind=>{const f=fixture();if(kind==='attempt')f.controllerRun.run_attempt=2;if(kind==='cancelled')f.controllerRun.status='completed';if(kind==='definition')f.controllerRun.workflow_id=98;if(kind==='candidate')f.controllerRun.head_sha=base;await expect(verify(f)).rejects.toThrow(/controller/);});
 it('allows completed-success requesting CI only in shadow mode',async()=>{const f=fixture();f.ciRun.status='completed';f.ciRun.conclusion='success';await expect(verify(f)).rejects.toThrow(/requesting/);f.request.mode='shadow';await verify(f);f.ciRun.conclusion='failure';await expect(verify(f)).rejects.toThrow(/requesting/);});
 it('rejects a newer requesting run queued while the old run remains active',async()=>{const f=fixture();f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:args.workflow_id===99?[f.controllerRun]:[{...f.ciRun,id:322,status:'queued'}]}}));await expect(verify(f)).rejects.toThrow(/newer|superseded/);});
 it('fails closed on API denial and untrusted helper origin',async()=>{const f=fixture();f.github.rest.repos.getCommit.mockRejectedValue(new Error('API denied'));await expect(verify(f)).rejects.toThrow('API denied');f.origin.ref='refs/heads/stack/parent';await expect(verify(f)).rejects.toThrow(/default.branch/);});
});

it.each(['MATRIX_CI_DEDICATED_ENABLED','MATRIX_CI_RUNNER_IMAGE_DIGEST','MATRIX_CI_RUNNER_HARNESS_DIGEST'])('revokes grant/renewal when current reviewed %s changes',async name=>{
 const f=fixture();f.github.rest.actions.getRepoVariable.mockImplementation(async args=>({data:{name:args.name,value:args.name===name?'changed':args.name==='MATRIX_CI_CONTROLLER_SHA'?controller:args.name==='MATRIX_CI_RUNNER_IMAGE_DIGEST'?f.request.imageDigest:args.name==='MATRIX_CI_RUNNER_HARNESS_DIGEST'?f.request.harnessDigest:'true'}}));
 await expect(verify(f)).rejects.toThrow(/configuration|disabled/);
});
it('never transfers an old-base hosted run through mutable PR API linkage',async()=>{
 const f=fixture();f.ciRun.display_title=`CI coverage-v1 · ${head}`;await expect(verify(f)).rejects.toThrow(/requesting|CI/);
});

it('revokes the lease when the parent ref moves before GitHub refreshes the PR snapshot',async()=>{
 const f=fixture();f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:merge}}});await expect(verify(f)).rejects.toThrow(/parent ref|base ref/);
});

it('revokes an active controller when a newer matching controller is still queued before admission',async()=>{
 const f=fixture();f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:args.workflow_id===99?[f.controllerRun,{...f.controllerRun,id:124,status:'queued'}]:[f.ciRun]}}));
 await expect(verify(f)).rejects.toThrow(/newer controller|superseded/);
});
it('rejects an unrelated controller marker and never admits a different newest run',async()=>{
 const f=fixture();f.controllerRun.display_title='wrong controller source';await expect(verify(f)).rejects.toThrow(/controller/);
 f.controllerRun.display_title=`dedicated-ci-v2 pr=2454 head=${head} base=${base} requested=true`;
 f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:args.workflow_id===99?Array.from({length:100},(_,i)=>({...f.controllerRun,id:1+i})):[f.ciRun]}}));
 await expect(verify(f)).rejects.toThrow(/superseded|bounded|history/);
});

it('allows a main-definition refresh requester and its authenticated workflow_run controller',async()=>{
 const f=fixture();Object.assign(f.ciRun,{event:'workflow_dispatch',head_sha:controller,head_branch:'main',display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`,pull_requests:[]});
 Object.assign(f.controllerRun,{event:'workflow_run',head_sha:controller,head_branch:'main',display_title:`dedicated-refresh-v2 execution=true request=321 title=${f.ciRun.display_title}`});
 await verify(f);
 f.controllerRun.display_title=`dedicated-refresh-v2 execution=true request=322 title=${f.ciRun.display_title}`;await expect(verify(f)).rejects.toThrow(/controller/);
});
it('keeps reviewed helper pin stable across unrelated main commits but denies pin changes or nonancestor source',async()=>{
 const f=fixture();await verify(f);
 f.github.rest.actions.getRepoVariable.mockImplementation(async args=>({data:{name:args.name,value:args.name==='MATRIX_CI_CONTROLLER_SHA'?'0'.repeat(40):args.name==='MATRIX_CI_CONTROLLER_SHA'?controller:args.name==='MATRIX_CI_RUNNER_IMAGE_DIGEST'?f.request.imageDigest:args.name==='MATRIX_CI_RUNNER_HARNESS_DIGEST'?f.request.harnessDigest:'true'}}));
 await expect(verify(f)).rejects.toThrow(/configuration|pin/);
});

it('denies a reviewed pin that is no longer an ancestor of the live main ref',async()=>{const f=fixture();f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({data:{status:'diverged',merge_base_commit:{sha:base}}});await expect(verify(f)).rejects.toThrow(/ancestor/);});

it('finds the newest relevant leases despite three hundred retained unrelated runs',async()=>{
 const f=fixture();f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:[args.workflow_id===99?f.controllerRun:f.ciRun,...Array.from({length:99},(_,i)=>({...f.controllerRun,id:1+i,display_title:'unrelated retained schedule',event:'schedule'}))]}}));
 await verify(f);expect(f.github.rest.actions.listWorkflowRuns.mock.calls.every(([args]:any[])=>args.page===1)).toBe(true);
});

it('binds native actual merge parents at lock and every later renewal',async()=>{
 const {nativeStackFixture}=await import('./helpers/native-stack-fixture');const native=nativeStackFixture(),f=fixture();
 Object.assign(f.request,{prNumber:native.pull.number,headSha:native.snapshot.headSha,baseSha:native.snapshot.baseSha,baseRef:native.snapshot.baseRef,mergeSha:native.snapshot.sourceSha,mergeParents:native.snapshot.mergeParents});
 const g:any=f.github;g.request=native.github.request;g.rest.pulls=native.github.rest.pulls;g.rest.git=native.github.rest.git;g.rest.repos.getCommit=native.github.rest.repos.getCommit;
 Object.assign(f.controllerRun,{head_sha:f.request.headSha,head_branch:native.pull.head.ref,display_title:`dedicated-ci-v2 pr=${f.request.prNumber} head=${f.request.headSha} base=${f.request.baseSha} requested=true`});
 Object.assign(f.ciRun,{head_sha:f.request.headSha,head_branch:native.pull.head.ref,display_title:`CI coverage-v1 · ${f.request.mergeSha}`,pull_requests:[{number:f.request.prNumber,head:{sha:f.request.headSha,ref:native.pull.head.ref},base:{sha:f.request.baseSha,ref:f.request.baseRef}}]});
 await verify(f);await verify(f);native.parent.merge_commit_sha='0'.repeat(40);await expect(verify(f)).rejects.toThrow();
});

it.each(['completed','in_progress'])('reconcile-only newer %s controller cannot revoke an executing lease',async status=>{
 const f=fixture();const extra={...f.controllerRun,id:124,event:'workflow_run',head_branch:'main',head_sha:controller,status,display_title:`dedicated-refresh-v2 execution=false request=321 title=CI coverage-v1 · ${merge}`};
 f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:args.workflow_id===99?[extra,f.controllerRun]:[f.ciRun]}}));
 await verify(f);
 extra.display_title=`dedicated-refresh-v2 execution=true request=321 title=CI coverage-v1 · ${merge}`;
 await expect(verify(f)).rejects.toThrow(/superseded/);
});
