import {expect,it,vi} from 'vitest';
import {reconcileSourceQualification} from '../../scripts/ci/dedicated-source-gate.mjs';
import {HOSTED_LANES} from '../../scripts/ci/dedicated-hosted.mjs';
import {pinArtifactFixture} from './helpers/dedicated-artifact-fixture';
const source='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40),controllerSha='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'},origin={sha:controllerSha,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
function fixture(){
 const ci={id:321,run_attempt:1,workflow_id:98,event:'push',path:'.github/workflows/ci.yml',head_sha:source,head_branch:'main',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},status:'completed',conclusion:'success',display_title:`CI coverage-v1 · ${source}`};
 const controller={...ci,id:124,workflow_id:99,event:'workflow_run',path:'.github/workflows/ci-dedicated.yml',display_title:`dedicated-refresh-v2 execution=true request=321 title=${ci.display_title}`};
 const check={id:12,name:'Dedicated CI Results',head_sha:source,app:{slug:'github-actions'},status:'completed',conclusion:'neutral',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124',output:{summary:JSON.stringify({schemaVersion:3,sourceKind:'main',prNumber:0,suite:'qualification',headSha:source,baseSha:base,baseRef:'main',sourceSha:source,mergeParents:[base],controllerSha,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',controllerAttempt:1,requestingRunId:321,requestingRunAttempt:1,mode:'delegated',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),receiptVerified:false,requestDigest:'9'.repeat(64),leaseId:'8'.repeat(32),outcome:'infrastructure-unavailable',status:76,reason:'queue_timeout',stage:'admission',workloadStarted:false,containerGone:true})}};
 const jobs=[...HOSTED_LANES,'CI Results'].map((name,i)=>({id:i+1,name,run_id:321,run_attempt:1,head_sha:source,status:'completed',conclusion:'success',check_run_url:`https://api.github.com/repos/HamedMP/matrix-os/check-runs/${i+1}`}));
 const aggregate={id:jobs.at(-1)!.id,name:'CI Results',app:{slug:'github-actions'},head_sha:source,status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/321/job/99'};
 const github={rest:{pulls:{list:vi.fn(async()=>({data:[]})),get:vi.fn()},git:{getRef:vi.fn(async()=>({data:{object:{sha:source}}}))},repos:{getCommit:vi.fn(async()=>({data:{sha:source,parents:[{sha:base}],commit:{tree:{sha:tree}}}}))},checks:{listForRef:vi.fn(async()=>({data:{check_runs:[check]}})),get:vi.fn(async()=>({data:aggregate})),create:vi.fn(),update:vi.fn()},actions:{getWorkflow:vi.fn(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:'.github/workflows/'+workflow_id}})),listRepoVariables:vi.fn(async()=>({data:{total_count:5,variables:[{name:'MATRIX_CI_CONTROLLER_SHA',value:controllerSha},{name:'MATRIX_CI_DEDICATED_ENABLED',value:'true'},{name:'MATRIX_CI_DEDICATED_SHADOW',value:'false'},{name:'MATRIX_CI_RUNNER_IMAGE_DIGEST',value:'sha256:'+'e'.repeat(64)},{name:'MATRIX_CI_RUNNER_HARNESS_DIGEST',value:'f'.repeat(64)}]}})),listWorkflowRuns:vi.fn(async({workflow_id}:any)=>({data:{workflow_runs:workflow_id===98?[ci]:[controller]}})),getWorkflowRun:vi.fn(async()=>({data:controller})),listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{name:`dedicated-qualification-${source}-${source}-${base}-pr0-request321-1-attempt1`,id:55,expired:false,size_in_bytes:2000,workflow_run:{id:124}}]}})),listJobsForWorkflowRun:vi.fn(async({run_id}:any)=>({data:run_id===124?{jobs:[{name:'benchmark',status:'completed',conclusion:'success'}]}:{total_count:jobs.length,jobs}})),createWorkflowDispatch:vi.fn()}}};
 const gateGithub={rest:{checks:{create:vi.fn(async(args:any)=>({data:{id:100,...args,app:{id:777,slug:'matrix-ci-gate'}}})),update:vi.fn(async(args:any)=>({data:{id:args.check_run_id,name:'CI Source Qualification',head_sha:source,...args,app:{id:777,slug:'matrix-ci-gate'}}}))}}};
 pinArtifactFixture(github,check,controller);return{github,gateGithub,ci,controller,check,jobs,aggregate};
}
const reconcile=(f:ReturnType<typeof fixture>)=>reconcileSourceQualification(f.github,repo,origin,{runId:123,runAttempt:1,gateAppId:777,gateGithub:f.gateGithub});
const written=(f:ReturnType<typeof fixture>)=>f.gateGithub.rest.checks.create.mock.calls.at(-1)?.[0];
it('independently verifies exact main infrastructure recovery even with no open PRs',async()=>{
 const f=fixture();await reconcile(f);
 expect(written(f)).toMatchObject({name:'CI Source Qualification',head_sha:source,conclusion:'success'});
 expect(JSON.parse(written(f).output.summary)).toMatchObject({sourceKind:'main',prNumber:0,sourceSha:source,mergeParents:[base],requestingRunId:321,requestingRunAttempt:1,infrastructureFallback:true});
 expect(f.github.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({run_id:321,filter:'latest',request:expect.objectContaining({timeout:10000})}));
 expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.checks.update).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it.each(['missing','skipped','failed','attempt','head','run','duplicate','truncated','fake-app','aggregate-run','inventory-denied','requester-pending','requester-attempt','receipt-missing','main-moved','newer-attempt'])('fails the independent main App gate for %s despite a green Actions aggregate',async kind=>{
 const f=fixture();
 if(kind==='missing')f.jobs.splice(0,1);if(kind==='skipped')f.jobs[0].conclusion='skipped';if(kind==='failed')f.jobs[0].conclusion='failure';if(kind==='attempt')f.jobs[0].run_attempt=2;if(kind==='head')f.jobs[0].head_sha=base;if(kind==='run')f.jobs[0].run_id=999;if(kind==='duplicate')f.jobs.push({...f.jobs[0],id:999});
 if(kind==='truncated')f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async({run_id}:any)=>({data:run_id===124?{jobs:[{name:'benchmark',status:'completed',conclusion:'success'}]}:{total_count:101,jobs:f.jobs}}));
 if(kind==='fake-app')f.aggregate.app.slug='other';if(kind==='aggregate-run')f.aggregate.details_url='https://github.com/HamedMP/matrix-os/actions/runs/999/job/99';
 if(kind==='inventory-denied'){const original=f.github.rest.actions.listJobsForWorkflowRun.getMockImplementation()!;f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async args=>{if(args.run_id===321)throw new Error('API denied');return original(args);});}
 if(kind==='requester-pending')f.ci.status='in_progress';if(kind==='requester-attempt')f.ci.run_attempt=2;if(kind==='receipt-missing')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[]}});
 if(kind==='main-moved'){const original=f.github.rest.actions.listJobsForWorkflowRun.getMockImplementation()!;f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async args=>{const result=await original(args);if(args.run_id===321)f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:base}}});return result;});}
 if(kind==='newer-attempt'){const original=f.github.rest.actions.listJobsForWorkflowRun.getMockImplementation()!;f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async args=>{const result=await original(args);if(args.run_id===321)f.github.rest.actions.listWorkflowRuns.mockImplementation(async({workflow_id}:any)=>({data:{workflow_runs:workflow_id===98?[{...f.ci,run_attempt:2,status:'queued'}]:[f.controller]}}));return result;});}
 await reconcile(f);expect(written(f)).toMatchObject({name:'CI Source Qualification',head_sha:source,conclusion:'failure'});
 expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.checks.update).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it('does not introduce dedicated qualification for an ordinary main run while routing is disabled',async()=>{
 const f=fixture();f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:0,variables:[]}});f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
});
it('qualifies genuine exact-main Linux evidence without claiming hosted fallback',async()=>{
 const f=fixture(),summary=JSON.parse(f.check.output.summary);
 for(const key of ['outcome','status','reason','stage','workloadStarted','containerGone'])delete summary[key];
 summary.receiptVerified=true;f.check.conclusion='success';f.check.output.summary=JSON.stringify(summary);pinArtifactFixture(f.github,f.check,f.controller);
 await reconcile(f);expect(written(f)).toMatchObject({conclusion:'success'});expect(JSON.parse(written(f).output.summary).infrastructureFallback).toBeUndefined();
 expect(f.github.rest.actions.listJobsForWorkflowRun.mock.calls.every(([args])=>args.run_id===124)).toBe(true);
});
it.each(['complete','skipped'])('retains independent main recovery after switching routing off: %s',async kind=>{
 const f=fixture();const prior={id:99,name:'CI Source Qualification',head_sha:source,app:{id:777,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124',output:{summary:JSON.stringify({schemaVersion:1,sourceKind:'main',prNumber:0,headSha:source,sourceSha:source,baseSha:base,baseRef:'main',mergeParents:[base],qualificationMode:'delegated',controllerSha,controllerRef:'refs/heads/main',controllerAttempt:1,admittedPreviously:true})},conclusion:'success'};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[f.check,prior]}});
 const configuration=(await f.github.rest.actions.listRepoVariables()).data;
 configuration.variables.find(value=>value.name==='MATRIX_CI_DEDICATED_ENABLED')!.value='false';f.github.rest.actions.listRepoVariables.mockResolvedValue({data:configuration});
 if(kind==='skipped')f.jobs[0].conclusion='skipped';
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({check_run_id:99,conclusion:kind==='complete'?'success':'failure'}));
 expect(f.gateGithub.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 const args=f.gateGithub.rest.checks.update.mock.calls.at(-1)![0];expect(JSON.parse(args.output.summary).notApplicable).toBeUndefined();
});
it('never uses a candidate-branch controller to update the main App-owned gate',async()=>{
 const f=fixture();const prior={id:99,name:'CI Source Qualification',head_sha:source,app:{id:777,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/125',output:{summary:JSON.stringify({schemaVersion:1,sourceKind:'main',prNumber:0,headSha:source,controllerSha,controllerRef:'refs/heads/main',controllerAttempt:1})}};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[f.check,prior]}});
 f.github.rest.actions.getWorkflowRun.mockImplementation(async args=>({data:args.run_id===125?{...f.controller,id:125,head_sha:base,head_branch:'candidate'}:f.controller}));
 await reconcile(f);expect(written(f)).toMatchObject({conclusion:'success'});expect(f.gateGithub.rest.checks.update).not.toHaveBeenCalled();
});
it('cannot use an Actions-owned App response to claim independent main qualification',async()=>{
 const f=fixture();f.gateGithub.rest.checks.create.mockImplementation(async args=>({data:{id:100,...args,app:{id:15368,slug:'github-actions'}}}));
 await expect(reconcile(f)).rejects.toThrow(/App issuer/);expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.checks.update).not.toHaveBeenCalled();
});
