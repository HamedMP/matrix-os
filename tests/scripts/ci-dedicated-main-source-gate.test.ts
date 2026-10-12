import {expect,it,vi} from 'vitest';
import {reconcileSourceQualification} from '../../scripts/ci/dedicated-source-gate.mjs';
import {HOSTED_LANES} from '../../scripts/ci/dedicated-hosted.mjs';
import {pinArtifactFixture,receiptZip,artifactDownloadApi} from './helpers/dedicated-artifact-fixture';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {writeMainCiDecision,cleanupMainCiDecision} from '../../scripts/ci/main-ci-decision.mjs';
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
 pinArtifactFixture(github,check,controller);const result={github,gateGithub,ci,controller,check,jobs,aggregate};pinFullDecision(result);return result;
}

function pinFullDecision(f:ReturnType<typeof fixture>){
 if(!f.jobs.some(job=>job.name==='Detect CI-relevant changes'))f.jobs.push({...f.jobs[0],id:90,name:'Detect CI-relevant changes',conclusion:'success',steps:['Detect source changes','Select guarded Linux delegation','Record exact main coverage decision','Upload exact main coverage decision'].map((name,i)=>({number:i+1,name,status:'completed',conclusion:'success'}))} as any);
 const decision={schemaVersion:1,sourceKind:'main',repository:'HamedMP/matrix-os',workflowRef:'HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/main',sourceSha:source,requestingRunId:321,requestingRunAttempt:1,coverageBaseSha:base,bootstrap:false,shouldRun:true,docsContractTests:true,osViewParityTests:true,dedicatedEligible:true,dedicatedRequired:true};
 const bytes=receiptZip(decision),artifact={id:56,name:`main-ci-decision-${source}-321-1`,expired:false,size_in_bytes:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),workflow_run:{id:321,head_sha:source}};
 const originalDownload=f.github.rest.actions.downloadArtifact,originalInventory=f.github.rest.actions.listWorkflowRunArtifacts.getMockImplementation()!;
 f.github.rest.actions.downloadArtifact=async(args:any)=>args.artifact_id===56?artifactDownloadApi(bytes)(args):originalDownload(args);
 f.github.rest.actions.listWorkflowRunArtifacts.mockImplementation(async(args:any)=>args.run_id===321?{data:{total_count:1,artifacts:[artifact]}} as any:originalInventory(args));
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
 summary.receiptVerified=true;f.check.conclusion='success';f.check.output.summary=JSON.stringify(summary);pinArtifactFixture(f.github,f.check,f.controller);pinFullDecision(f);
 await reconcile(f);expect(written(f)).toMatchObject({conclusion:'success'});expect(JSON.parse(written(f).output.summary).infrastructureFallback).toBeUndefined();
 expect(f.github.rest.actions.listJobsForWorkflowRun.mock.calls.filter(([args])=>args.run_id===321)).toHaveLength(1);expect(f.github.rest.actions.listJobsForWorkflowRun.mock.calls.every(([args])=>[124,321].includes(args.run_id))).toBe(true);
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

function docsFixture(){
 const f=fixture();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[]}});
 for(const job of f.jobs)if(!['Docs Contract Tests','OS View Parity','CI Results'].includes(job.name))job.conclusion='skipped';
 f.jobs.splice(f.jobs.findIndex(j=>j.name==='Detect CI-relevant changes'),1);
 const detector={...f.jobs[0],id:90,name:'Detect CI-relevant changes',conclusion:'success',steps:['Detect source changes','Select guarded Linux delegation','Record exact main coverage decision','Upload exact main coverage decision'].map((name,i)=>({number:i+1,name,status:'completed',conclusion:'success'}))};f.jobs.push(detector);
 const decision:any={schemaVersion:1,sourceKind:'main',repository:'HamedMP/matrix-os',workflowRef:'HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/main',sourceSha:source,requestingRunId:321,requestingRunAttempt:1,coverageBaseSha:base,bootstrap:false,shouldRun:false,docsContractTests:true,osViewParityTests:true,dedicatedEligible:false,dedicatedRequired:false};
 const artifact:any={id:56,name:`main-ci-decision-${source}-321-1`,expired:false,size_in_bytes:1000,digest:'',workflow_run:{id:321,head_sha:source}};
 const pin=()=>{const bytes=receiptZip(decision);artifact.size_in_bytes=bytes.length;artifact.digest='sha256:'+createHash('sha256').update(bytes).digest('hex');f.github.rest.actions.downloadArtifact=artifactDownloadApi(bytes);};pin();
 f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{total_count:1,artifacts:[artifact]}} as any);
 return{...f,detector,decision,artifact,pin};
}
it('qualifies actual docs-only main selected jobs without a nonexistent Linux receipt',async()=>{
 const f=docsFixture();await reconcile(f);
 expect(written(f)).toMatchObject({conclusion:'success',head_sha:source});
 expect(JSON.parse(written(f).output.summary)).toMatchObject({sourceKind:'main',sourceSha:source,requestingRunId:321,requestingRunAttempt:1,docsOnly:true,selectedHostedLaneCount:2});
 expect(f.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(expect.objectContaining({run_id:321}));
 expect(f.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it.each(['missing-docs','failed-docs','skipped-parity','wrong-attempt','spoofed-run','spoofed-source','spoofed-workflow','spoofed-repository','string-boolean','bootstrap-string','missing-decision','duplicate-decision','missing-digest','tampered-digest','artifact-run','artifact-source','detector-failed','route-skipped','upload-missing','backend-only','fake-issuer','retried-run','stale-main','unselected-failure','unexpected-source-work'])('denies docs-only main qualification from %s',async kind=>{
 const f=docsFixture();const docs=f.jobs.find(j=>j.name==='Docs Contract Tests')!,parity=f.jobs.find(j=>j.name==='OS View Parity')!;
 if(kind==='missing-docs')f.jobs.splice(f.jobs.indexOf(docs),1);if(kind==='failed-docs')docs.conclusion='failure';if(kind==='skipped-parity')parity.conclusion='skipped';if(kind==='wrong-attempt')docs.run_attempt=2;
 if(kind==='spoofed-run')f.decision.requestingRunId=999;if(kind==='spoofed-source')f.decision.sourceSha=base;if(kind==='spoofed-workflow')f.decision.workflowRef='HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/candidate';if(kind==='spoofed-repository')f.decision.repository='fork/matrix-os';if(kind==='string-boolean')f.decision.shouldRun='false';if(kind==='bootstrap-string')f.decision.bootstrap='false';
 f.pin();
 if(kind==='missing-decision'||kind==='backend-only')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{total_count:0,artifacts:[]}} as any);
 if(kind==='duplicate-decision')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{total_count:2,artifacts:[f.artifact,{...f.artifact,id:57}]}} as any);
 if(kind==='missing-digest')delete f.artifact.digest;if(kind==='tampered-digest')f.artifact.digest='sha256:'+'0'.repeat(64);if(kind==='artifact-run')f.artifact.workflow_run.id=999;if(kind==='artifact-source')f.artifact.workflow_run.head_sha=base;
 if(kind==='detector-failed')f.detector.conclusion='failure';if(kind==='route-skipped')f.detector.steps[1].conclusion='skipped';if(kind==='upload-missing')f.detector.steps.pop();
 if(kind==='fake-issuer')f.aggregate.app.slug='other';if(kind==='retried-run')f.ci.run_attempt=2;
 if(kind==='stale-main'){const original=f.github.rest.actions.listWorkflowRunArtifacts.getMockImplementation()!;f.github.rest.actions.listWorkflowRunArtifacts.mockImplementation(async args=>{const result=await original(args);f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:base}}});return result;});}
 if(kind==='unselected-failure')f.jobs[0].conclusion='failure';if(kind==='unexpected-source-work')f.jobs[0].conclusion='success';
 await reconcile(f);expect(written(f)).toMatchObject({conclusion:'failure'});
 expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

it('requires only actually selected parity for a valid no-source/no-docs main decision',async()=>{
 const f=docsFixture();f.decision.docsContractTests=false;f.jobs.find(job=>job.name==='Docs Contract Tests')!.conclusion='skipped';f.pin();
 await reconcile(f);expect(written(f)).toMatchObject({conclusion:'success'});expect(JSON.parse(written(f).output.summary)).toMatchObject({docsOnly:true,selectedHostedLaneCount:1});
});
// Persist actual App responses and authenticate their protected controller on later cycles.
function retainAppHistory(f:ReturnType<typeof fixture>){
 let prior:any;const originalList=f.github.rest.checks.listForRef.getMockImplementation()!;
 f.github.rest.checks.listForRef.mockImplementation(async args=>{const value=await originalList(args);return{data:{check_runs:[...value.data.check_runs,...(prior?[prior]:[])]}};});
 const protectedRun={...f.controller,id:123,event:'schedule',head_branch:'main'};
 f.github.rest.actions.getWorkflowRun.mockImplementation(async args=>({data:args.run_id===123?protectedRun:f.controller}));
 const save=async(args:any)=>{prior={id:100,name:'CI Source Qualification',head_sha:source,...args,app:{id:777,slug:'matrix-ci-gate'}};return{data:prior};};
 f.gateGithub.rest.checks.create.mockImplementation(save);f.gateGithub.rest.checks.update.mockImplementation(save);
 return{current:()=>prior};
}
it.each(['expired','deleted','transient-failure','source-api-failure'])('revalidates durable authenticated main decision after artifact %s',async kind=>{
 const f=docsFixture(),history=retainAppHistory(f);await reconcile(f);
 expect(history.current().conclusion).toBe('success');const proof=JSON.parse(history.current().output.summary).coverageProof;
 expect(proof).toMatchObject({schemaVersion:1,origin:'main-ci-decision-artifact-v1',qualified:true,artifact:{id:56,name:f.artifact.name,digest:f.artifact.digest},decision:f.decision});
 f.artifact.expired=true;
 if(kind==='deleted')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{total_count:0,artifacts:[]}} as any);
 if(kind==='source-api-failure'){
  f.github.rest.repos.getCommit.mockRejectedValueOnce(new Error('Temporary source API failure'));await reconcile(f);
  expect(history.current().conclusion).toBe('failure');expect(JSON.parse(history.current().output.summary).coverageProof).toEqual(proof);
 }
 if(kind==='transient-failure'){
  const list=f.github.rest.actions.listJobsForWorkflowRun.getMockImplementation()!;f.github.rest.actions.listJobsForWorkflowRun.mockRejectedValueOnce(new Error('Temporary API failure'));
  await reconcile(f);expect(history.current().conclusion).toBe('failure');expect(JSON.parse(history.current().output.summary).coverageProof).toEqual(proof);
  f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(list);
 }
 const inventories=f.github.rest.actions.listJobsForWorkflowRun.mock.calls.length;await reconcile(f);
 expect(history.current().conclusion).toBe('success');expect(JSON.parse(history.current().output.summary).coverageProof).toEqual(proof);
 expect(f.github.rest.actions.listJobsForWorkflowRun.mock.calls.length).toBeGreaterThan(inventories);expect(Buffer.byteLength(history.current().output.summary)).toBeLessThanOrEqual(4096);
});
it.each(['fake-issuer','versionless','unqualified','wrong-decision','wrong-artifact','wrong-source','wrong-base','wrong-parents','wrong-controller','wrong-image','wrong-harness','wrong-mode','old-run','new-attempt','new-requester','parent-drift','selected-failed','detector-skipped','aggregate-forged','api-denied','duplicate-artifact','changed-digest','changed-artifact','extra-proof-key','wrong-origin','future-proof','wrong-workflow','duplicate-parents','download-denied','not-applicable','neutral-prior','pending-prior'])('fails closed when durable main coverage is %s',async kind=>{
 const f=docsFixture(),history=retainAppHistory(f);await reconcile(f);expect(history.current().conclusion).toBe('success');
 const prior=history.current(),evidence=JSON.parse(prior.output.summary),proof=evidence.coverageProof;f.artifact.expired=true;
 if(kind==='fake-issuer')prior.app.id=666;if(kind==='not-applicable')evidence.notApplicable=true;if(kind==='neutral-prior')prior.conclusion='neutral';if(kind==='pending-prior')prior.status='in_progress';
 expect(proof).toBeDefined();
 {
  if(kind==='extra-proof-key')proof.extra=true;if(kind==='wrong-origin')proof.origin='legacy-summary';if(kind==='future-proof')proof.qualifiedAt='2099-01-01T00:00:00.000Z';if(kind==='wrong-workflow')proof.controller.workflow='.github/workflows/ci.yml';if(kind==='duplicate-parents')proof.source.mergeParents=[base,base];
  if(kind==='versionless')delete proof.schemaVersion;if(kind==='unqualified')proof.qualified=false;
  if(kind==='wrong-decision')proof.decision.shouldRun='false';if(kind==='wrong-artifact')proof.artifact.digest='';
  if(kind==='wrong-source')proof.source.sourceSha=base;if(kind==='wrong-base')proof.source.baseSha=source;if(kind==='wrong-parents')proof.source.mergeParents=[source];
  if(kind==='wrong-controller')proof.controller.sha=base;if(kind==='wrong-image')proof.controller.imageDigest='sha256:'+'0'.repeat(64);if(kind==='wrong-harness')proof.controller.harnessDigest='0'.repeat(64);if(kind==='wrong-mode')proof.controller.mode='shadow';
  if(kind==='old-run')proof.decision.requestingRunId=999;
 }
 prior.output.summary=JSON.stringify(evidence);
 if(kind==='new-attempt')f.ci.run_attempt=2;if(kind==='new-requester')f.ci.id=322;
 if(kind==='parent-drift')f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:source,parents:[{sha:source}],commit:{tree:{sha:tree}}}});
 if(kind==='selected-failed')f.jobs.find(job=>job.name==='Docs Contract Tests')!.conclusion='failure';if(kind==='detector-skipped')f.detector.steps[1].conclusion='skipped';if(kind==='aggregate-forged')f.aggregate.app.slug='other';
 if(kind==='download-denied'){f.artifact.expired=false;f.github.rest.actions.downloadArtifact=async()=>{throw new Error('API denied');};}
 if(kind==='api-denied')f.github.rest.actions.listWorkflowRunArtifacts.mockRejectedValue(new Error('API denied'));
 if(kind==='duplicate-artifact')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{total_count:2,artifacts:[f.artifact,{...f.artifact,id:57}]}} as any);
 if(kind==='changed-digest')f.artifact.digest='sha256:'+'0'.repeat(64);if(kind==='changed-artifact')f.artifact.id=57;
 await reconcile(f);expect(history.current().conclusion).toBe('failure');
});
it('does not bootstrap a durable decision from an already expired artifact',async()=>{
 const f=docsFixture();f.artifact.expired=true;await reconcile(f);expect(written(f).conclusion).toBe('failure');expect(JSON.parse(written(f).output.summary).coverageProof).toBeUndefined();
});
it('still requires complete source workloads when only the full-scope detector decision expires',async()=>{
 const f=fixture(),history=retainAppHistory(f);await reconcile(f);expect(history.current().conclusion).toBe('success');
 const inventory=(await f.github.rest.actions.listWorkflowRunArtifacts({run_id:321} as any)).data as any;inventory.artifacts[0].expired=true;
 await reconcile(f);expect(history.current().conclusion).toBe('success');expect(JSON.parse(history.current().output.summary).infrastructureFallback).toBe(true);
 f.jobs[0].conclusion='skipped';await reconcile(f);expect(history.current().conclusion).toBe('failure');
});

it('never substitutes the cached detector decision for an expired private Linux qualification receipt',async()=>{
 const f=fixture(),history=retainAppHistory(f);await reconcile(f);expect(history.current().conclusion).toBe('success');
 const original=f.github.rest.actions.listWorkflowRunArtifacts.getMockImplementation()!;
 f.github.rest.actions.listWorkflowRunArtifacts.mockImplementation(async args=>{const value:any=await original(args);for(const artifact of value.data.artifacts)artifact.expired=true;return value;});
 await reconcile(f);expect(history.current().conclusion).toBe('failure');
});

it('retains exact authenticated docs coverage after routing is switched off and its artifact expires',async()=>{
 const f=docsFixture(),history=retainAppHistory(f);await reconcile(f);expect(history.current().conclusion).toBe('success');
 const configuration=(await f.github.rest.actions.listRepoVariables()).data;configuration.variables.find(value=>value.name==='MATRIX_CI_DEDICATED_ENABLED')!.value='false';
 f.github.rest.actions.listRepoVariables.mockResolvedValue({data:configuration});f.artifact.expired=true;
 await reconcile(f);expect(history.current().conclusion).toBe('success');expect(JSON.parse(history.current().output.summary).qualificationMode).toBe('delegated');
});
it('cannot mint durable original-success proof when selected main work has never passed',async()=>{
 const f=docsFixture(),history=retainAppHistory(f),docs=f.jobs.find(job=>job.name==='Docs Contract Tests')!;docs.conclusion='failure';
 await reconcile(f);expect(history.current().conclusion).toBe('failure');expect(JSON.parse(history.current().output.summary).coverageProof).toBeUndefined();
 docs.conclusion='success';f.artifact.expired=true;await reconcile(f);expect(history.current().conclusion).toBe('failure');expect(JSON.parse(history.current().output.summary).coverageProof).toBeUndefined();
});

function producerEnv(directory:string){return{RUNNER_TEMP:directory,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'HamedMP/matrix-os',GITHUB_WORKFLOW_REF:'HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/main',GITHUB_SHA:source,GITHUB_RUN_ID:'321',GITHUB_RUN_ATTEMPT:'1',COVERAGE_BASE_SHA:base,COVERAGE_BOOTSTRAP:'false',SHOULD_RUN:'false',DOCS_CONTRACT_TESTS:'true',OS_VIEW_PARITY_TESTS:'true',DEDICATED_ELIGIBLE:'false',DEDICATED_REQUIRED:'false'};}
it('records the actual detector/route outputs once and cleans only its owned bounded proof',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'main-decision-producer-')),env=producerEnv(directory);
 try{
  const actual=await writeMainCiDecision(env),file=join(directory,'main-ci-decision','receipt.json');
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(actual);expect(actual).toMatchObject({sourceSha:source,requestingRunId:321,requestingRunAttempt:1,shouldRun:false,docsContractTests:true,osViewParityTests:true,dedicatedEligible:false,dedicatedRequired:false});
  expect(readdirSync(join(directory,'main-ci-decision'))).toEqual(['receipt.json']);
  await expect(writeMainCiDecision({...env,DOCS_CONTRACT_TESTS:'false'})).rejects.toThrow(/EEXIST/);expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(actual);
  await cleanupMainCiDecision(env);expect(existsSync(file)).toBe(false);expect(existsSync(join(directory,'main-ci-decision'))).toBe(false);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it.each(['pull-request','wrong-ref','wrong-workflow','malformed-boolean','contradictory-route','missing-base','bad-run'])('does not publish a main coverage proof for %s',async kind=>{
 const directory=mkdtempSync(join(tmpdir(),'main-decision-invalid-')),env=producerEnv(directory);
 if(kind==='pull-request')env.GITHUB_EVENT_NAME='pull_request';if(kind==='wrong-ref')env.GITHUB_REF='refs/heads/candidate';if(kind==='wrong-workflow')env.GITHUB_WORKFLOW_REF='HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/candidate';if(kind==='malformed-boolean')env.SHOULD_RUN='0';if(kind==='contradictory-route')env.DEDICATED_ELIGIBLE='true';if(kind==='missing-base')env.COVERAGE_BASE_SHA='';if(kind==='bad-run')env.GITHUB_RUN_ID='0';
 try{await expect(writeMainCiDecision(env)).rejects.toThrow();expect(existsSync(join(directory,'main-ci-decision','receipt.json'))).toBe(false);}finally{rmSync(directory,{recursive:true,force:true});}
});
it('rejects a symlinked proof directory without writing or cleaning external owner data',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'main-decision-symlink-')),external=mkdtempSync(join(tmpdir(),'main-decision-owner-')),env=producerEnv(directory);
 const sentinel=join(external,'receipt.json');writeFileSync(sentinel,'owner-data');symlinkSync(external,join(directory,'main-ci-decision'));
 try{await expect(writeMainCiDecision(env)).rejects.toThrow(/Unsafe/);await expect(cleanupMainCiDecision(env)).rejects.toThrow(/Unsafe/);expect(readFileSync(sentinel,'utf8')).toBe('owner-data');}finally{rmSync(directory,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});}
});
it('wires the main-only immutable proof after the actual detector and route, with bounded retention and cleanup',()=>{
 const workflow=parse(readFileSync(join(process.cwd(),'.github/workflows/ci.yml'),'utf8')),steps=workflow.jobs.changes.steps;
 const record=steps.find((step:any)=>step.name==='Record exact main coverage decision'),upload=steps.find((step:any)=>step.name==='Upload exact main coverage decision'),cleanup=steps.find((step:any)=>step.name==='Clean temporary main coverage decision');
 expect(steps.indexOf(record)).toBeGreaterThan(steps.findIndex((step:any)=>step.name==='Select guarded Linux delegation'));expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(record));
 expect(record.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");expect(upload.if).toBe(record.if);expect(record.run).toBe('node scripts/ci/main-ci-decision.mjs');
 expect(record.env).toEqual({COVERAGE_BASE_SHA:'${{ steps.changed.outputs.base_sha }}',COVERAGE_BOOTSTRAP:'${{ steps.changed.outputs.bootstrap }}',SHOULD_RUN:'${{ steps.changed.outputs.should_run }}',DOCS_CONTRACT_TESTS:'${{ steps.changed.outputs.docs_contract_tests }}',OS_VIEW_PARITY_TESTS:'${{ steps.changed.outputs.os_view_parity_tests }}',DEDICATED_ELIGIBLE:'${{ steps.route.outputs.eligible }}',DEDICATED_REQUIRED:'${{ steps.route.outputs.required }}'});
 expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');expect(upload.with).toEqual({name:'main-ci-decision-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',path:'${{ runner.temp }}/main-ci-decision/receipt.json','if-no-files-found':'error','retention-days':1});
 expect(cleanup.if).toBe("always() && github.event_name == 'push' && github.ref == 'refs/heads/main'");expect(cleanup.run).toBe('node scripts/ci/main-ci-decision.mjs --cleanup');
});
