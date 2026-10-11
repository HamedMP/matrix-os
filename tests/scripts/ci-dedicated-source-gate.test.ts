import {describe,expect,it,vi} from 'vitest';
import * as gate from '../../scripts/ci/dedicated-source-gate.mjs';
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),main='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'},origin={sha:main,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
function fixture(){
 const pull={number:2454,state:'open',draft:false,labels:[] as {name:string}[],head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'stack/parent',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge};
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull})),list:vi.fn(async()=>({data:[pull]}))},git:{getRef:vi.fn(async()=>({data:{object:{sha:base}}}))},repos:{getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))},checks:{listForRef:vi.fn(async()=>({data:{check_runs:[] as any[]}})),create:vi.fn(async(args:any)=>({data:{id:10,...args}})),update:vi.fn(async()=>({data:{}}))},actions:{getWorkflow:vi.fn(async(args:{workflow_id:string})=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:'.github/workflows/'+args.workflow_id}})),getRepoVariable:vi.fn(async(args:{name:string})=>({data:{name:args.name,value:args.name==='MATRIX_CI_CONTROLLER_SHA'?main:args.name.includes('IMAGE')?'sha256:'+'e'.repeat(64):args.name.includes('HARNESS')?'f'.repeat(64):args.name.includes('SHADOW')?'true':'false'}})),getWorkflowRun:vi.fn(async()=>({data:{id:123,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',event:'schedule',head_sha:main,head_branch:'main',run_attempt:1,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[] as any[]}})),createWorkflowDispatch:vi.fn(async()=>({data:{}}))}}};
 const reviewed={rest:{...github.rest,actions:{...github.rest.actions,listRepoVariables:vi.fn(async()=>({data:{total_count:5,variables:await Promise.all(['MATRIX_CI_CONTROLLER_SHA','MATRIX_CI_DEDICATED_ENABLED','MATRIX_CI_DEDICATED_SHADOW','MATRIX_CI_RUNNER_IMAGE_DIGEST','MATRIX_CI_RUNNER_HARNESS_DIGEST'].map(async name=>(await github.rest.actions.getRepoVariable({name})).data))}}))}}};
 const gateGithub={rest:{checks:{create:vi.fn(async(args:any)=>({data:{id:10,...args,app:{id:777}}})),update:vi.fn(async(args:any)=>({data:{id:args.check_run_id,name:'CI Source Qualification',head_sha:head,...args,app:{id:777}}}))}}};return{pull,github:reviewed,gateGithub};
}
const reconcile=(f:ReturnType<typeof fixture>)=>gate.reconcileSourceQualification(f.github,repo,origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:777,gateGithub:f.gateGithub});
describe('always-required default-controller source gate',()=>{
 it('creates explicit N/A success on an unlabeled ordinary PR without dispatch or Actions-owned edits',async()=>{const f=fixture();await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification',head_sha:head,conclusion:'success'}));expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();expect(f.gateGithub.rest.checks.update).not.toHaveBeenCalled();});
 it('fails the freshness gate and dispatches main CI for current same-head/new-parent merge',async()=>{const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification',head_sha:head,conclusion:'failure'}));expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci.yml',ref:'main',inputs:{pr_number:'2454',head_sha:head,base_sha:base,source_sha:merge},request:{timeout:10000}}));});
 it('does not dispatch when live parent ref moved before the PR merge snapshot updates',async()=>{const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:main}}});await reconcile(f);expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({conclusion:'failure'}));});
 it.each(['origin','api'])('fails closed on %s and never synthesizes CI Results',async kind=>{const f=fixture();if(kind==='api')f.github.rest.actions.getRepoVariable.mockRejectedValue(new Error('API denied'));await expect(gate.reconcileSourceQualification(f.github,repo,kind==='origin'?{...origin,ref:'refs/heads/child'}:origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:777,gateGithub:f.gateGithub})).rejects.toThrow();expect(f.gateGithub.rest.checks.create.mock.calls.every(([args])=>args.name!=='CI Results')).toBe(true);});
 it('never updates another app or another workflow source gate',async()=>{const f=fixture();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[{id:9,name:'CI Source Qualification',head_sha:head,app:{slug:'other'},output:{summary:'{}'}}]}});await reconcile(f);expect(f.gateGithub.rest.checks.update).not.toHaveBeenCalled();});
});
it('writes N/A for a fork without invoking source execution or weakening hosted CI',async()=>{const f=fixture();f.pull.head.repo.full_name='fork/matrix-os';await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification',conclusion:'success'}));expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();});
it('reuses only authenticated source gate ownership and revokes parent-only old success',async()=>{
 const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];
 const prior={id:9,name:'CI Source Qualification',head_sha:head,app:{slug:'matrix-ci-gate',id:777},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1,headSha:head,baseSha:main,sourceSha:main})}};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[prior,{id:8,name:'CI Results',head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success'}]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({check_run_id:9,conclusion:'failure'}));
 expect(f.gateGithub.rest.checks.update.mock.calls.every(([args]:any[])=>args.check_run_id!==8)).toBe(true);
});
function completeFixture(){
 const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];
 const ci={id:321,run_attempt:1,workflow_id:98,event:'workflow_dispatch',path:'.github/workflows/ci.yml',head_sha:main,head_branch:'main',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},status:'completed',conclusion:'success',pull_requests:[],display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`};
 const controller={...ci,id:124,workflow_id:99,event:'workflow_run',path:'.github/workflows/ci-dedicated.yml',display_title:`dedicated-refresh-v2 execution=true request=321 title=${ci.display_title}`};
 const check={id:12,name:'Dedicated CI Results',head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124',output:{summary:JSON.stringify({schemaVersion:3,prNumber:2454,suite:'qualification',headSha:head,baseSha:base,baseRef:'stack/parent',sourceSha:merge,controllerSha:main,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',controllerAttempt:1,requestingRunId:321,requestingRunAttempt:1,mode:'shadow',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),receiptVerified:true,requestDigest:'9'.repeat(64),leaseId:'8'.repeat(32)})}};
 f.github.rest.actions.listWorkflowRuns.mockImplementation(async(args?:unknown)=>({data:{workflow_runs:(args as {workflow_id:number}).workflow_id===98?[ci]:[controller]}}));
 f.github.rest.actions.getWorkflowRun.mockResolvedValue({data:controller});f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[check]}});
 const github={rest:{...f.github.rest,actions:{...f.github.rest.actions,listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{name:`dedicated-qualification-${head}-${merge}-${base}-pr2454-request321-1-attempt1`,expired:false,size_in_bytes:2000,workflow_run:{id:124}}]}})),listJobsForWorkflowRun:vi.fn(async()=>({data:{jobs:[{name:'benchmark',status:'completed',conclusion:'success'}]}}))}}};
 return{...f,github,ci,controller,check};
}
it('restores only the distinct gate after real-shaped fresh hosted and complete dedicated evidence',async()=>{const f=completeFixture();await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification',conclusion:'success'}));expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();});
it.each(['failed','pending','attempt','missing','stale'])('cannot restore freshness from %s coverage',async kind=>{const f=completeFixture();if(kind==='failed')f.ci.conclusion='failure';if(kind==='pending')f.ci.status='queued';if(kind==='attempt')f.ci.run_attempt=2;if(kind==='missing')f.github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({data:{artifacts:[]}});if(kind==='stale')f.pull.merge_commit_sha=main;await reconcile(f);expect(f.gateGithub.rest.checks.create.mock.calls.every(([args]:any[])=>args.conclusion==='failure')).toBe(true);});
it.each(['push','schedule'])('never edits a candidate-branch %s impersonation of the default source gate',async event=>{
 const f=fixture();const check={id:9,name:'CI Source Qualification',head_sha:head,app:{slug:'matrix-ci-gate',id:777},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1})}};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[check]}});
 f.github.rest.actions.getWorkflowRun.mockResolvedValue({data:{id:123,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',event,head_sha:head,head_branch:'malicious-child',run_attempt:1,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).not.toHaveBeenCalled();expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification'}));
});
it.each(['ordinary','fork'])('establishes %s N/A before any protected execution pins exist',async kind=>{
 const f=fixture();if(kind==='fork')f.pull.head.repo.full_name='fork/matrix-os';f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:0,variables:[]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({name:'CI Source Qualification',conclusion:'success',output:expect.objectContaining({summary:expect.stringContaining('"notApplicable":true')})}));expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
it('fails an admitted PR before dispatch when the protected reviewed pins are missing',async()=>{
 const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:1,variables:[{name:'MATRIX_CI_DEDICATED_SHADOW',value:'true'}]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({conclusion:'failure'}));expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

it('rejects forged Actions-issued metadata while issuing only through the protected checks-only App',async()=>{
 const f=fixture();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[{id:900,name:'CI Source Qualification',head_sha:head,app:{id:15368,slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1})}}]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).not.toHaveBeenCalled();expect(f.gateGithub.rest.checks.create).toHaveBeenCalled();expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.checks.update).not.toHaveBeenCalled();
});
it('rejects a missing App writer or Actions App issuer before any gate write',async()=>{
 const f=fixture();await expect(gate.reconcileSourceQualification(f.github,repo,origin,{runId:123,runAttempt:1,gateAppId:15368})).rejects.toThrow(/App|issuer/);expect(f.github.rest.checks.create).not.toHaveBeenCalled();
});
it.each(['unlabel','switch-off'])('keeps old delegated green blocked after parent drift and %s until exact hosted replacement passes',async kind=>{
 const f=fixture();f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];
 const prior={id:9,name:'CI Source Qualification',head_sha:head,app:{id:777,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1,admittedPreviously:true,headSha:head,baseSha:base,sourceSha:merge})},conclusion:'success'};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[prior,{id:8,name:'CI Results',head_sha:head,app:{slug:'github-actions'},conclusion:'success'}]}});
 f.gateGithub.rest.checks.update.mockImplementation(async(args:any)=>{Object.assign(prior,args);return{data:prior};});
 const nextBase='6'.repeat(40),nextMerge='7'.repeat(40);f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:nextBase}}});await reconcile(f);expect(prior.conclusion).toBe('failure');
 f.pull.base.sha=nextBase;f.pull.merge_commit_sha=nextMerge;f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:nextMerge,parents:[{sha:nextBase},{sha:head}]}});
 if(kind==='unlabel')f.pull.labels=[{name:'ready-for-ci'}];else f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:0,variables:[]}});
 await reconcile(f);expect(prior.conclusion).toBe('failure');expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ref:'main',inputs:{pr_number:'2454',head_sha:head,base_sha:nextBase,source_sha:nextMerge,execution_mode:'hosted-only'}}));
 const ci={created_at:new Date().toISOString(),id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_sha:main,head_branch:'main',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI hosted-refresh-v1 pr=2454 head=${head} base=${nextBase} merge=${nextMerge}`,status:'queued',conclusion:'success'};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[ci]}});await reconcile(f);expect(prior.conclusion).toBe('failure');ci.status='completed';ci.conclusion='failure';await reconcile(f);expect(prior.conclusion).toBe('failure');ci.conclusion='success';
 const check={id:88,name:'CI Results',head_sha:main,status:'completed',conclusion:'success',app:{slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/321/job/44'};
 const github={rest:{...f.github.rest,actions:{...f.github.rest.actions,listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[{id:44,run_id:321,run_attempt:1,name:'CI Results',head_sha:main,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/88'}]}}))},checks:{...f.github.rest.checks,get:vi.fn(async()=>({data:check}))}}};
 await reconcile({...f,github});expect(prior.conclusion).toBe('success');expect(JSON.parse(prior.output.summary)).toMatchObject({hostedRecovery:true,admittedPreviously:true,requestingRunId:321,requestingRunAttempt:1,sourceSha:nextMerge});expect(f.github.rest.checks.create).not.toHaveBeenCalled();expect(f.github.rest.checks.update).not.toHaveBeenCalled();expect(f.gateGithub.rest.checks.update.mock.calls.every(([args]:any[])=>args.check_run_id===9)).toBe(true);
});
it('recovers old delegated history conservatively during App-issuer migration',async()=>{
 const f=fixture();f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[{id:12,name:'Dedicated CI Results',head_sha:head,app:{slug:'github-actions'},conclusion:'success'}]}});await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({conclusion:'failure'}));expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({inputs:expect.objectContaining({execution_mode:'hosted-only'})}));
});
function hostedFixture(){
 const f=fixture();const prior={id:9,name:'CI Source Qualification',head_sha:head,app:{id:777,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1,admittedPreviously:true,headSha:head,baseSha:base,sourceSha:merge,executionMode:'hosted-only',recoveryStartedAt:new Date(Date.now()-20000).toISOString(),recoveryAfterRunId:320})}};f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[prior]}});
 const run={created_at:new Date(Date.now()-10000).toISOString(),id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_sha:main,head_branch:'main',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI hosted-refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`,status:'completed',conclusion:'success'};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[run]}});const job={id:44,run_id:321,run_attempt:1,name:'CI Results',head_sha:main,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/88'};const check={id:88,name:'CI Results',head_sha:main,status:'completed',conclusion:'success',app:{slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/321/job/44'};
 const github={rest:{...f.github.rest,actions:{...f.github.rest.actions,listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[job]}}))},checks:{...f.github.rest.checks,get:vi.fn(async()=>({data:check}))}}};return{...f,github,run,job,check};
}
it.each(['job-failed','job-skipped','job-attempt','job-run','job-source','check-app','check-run','newer-pending','inventory','denial'])('never restores hosted recovery from %s aggregate evidence',async kind=>{
 const f=hostedFixture();if(kind==='job-failed')f.job.conclusion='failure';if(kind==='job-skipped')f.job.conclusion='skipped';if(kind==='job-attempt')f.job.run_attempt=2;if(kind==='job-run')f.job.run_id=999;if(kind==='job-source')f.job.head_sha=head;if(kind==='check-app')f.check.app.slug='other';if(kind==='check-run')f.check.details_url='https://github.com/HamedMP/matrix-os/actions/runs/999/job/44';if(kind==='newer-pending')f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[f.run,{...f.run,id:322,status:'queued'}]}});if(kind==='inventory')f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:101,jobs:[f.job]}});if(kind==='denial')f.github.rest.checks.get.mockRejectedValue(new Error('API denied'));
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({conclusion:'failure'}));expect(f.github.rest.checks.update).not.toHaveBeenCalled();
});
it('cannot fall back to a GITHUB_TOKEN writer if the dedicated App response has another issuer',async()=>{
 const f=fixture();f.gateGithub.rest.checks.create.mockImplementation(async(args:any)=>({data:{id:10,...args,app:{id:15368,slug:'github-actions'}}}));await expect(reconcile(f)).rejects.toThrow(/issuer/);expect(f.github.rest.checks.create).not.toHaveBeenCalled();
});

it.each(['unlabel','switch-off'])('requires a fresh main hosted dispatch after unchanged-source %s despite genuine delegated green',async kind=>{
 const f=hostedFixture();
 if(kind==='unlabel')f.pull.labels=[{name:'ready-for-ci'}];else{f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:0,variables:[]}});}
 const previous={...f.run,event:'pull_request',head_sha:head,head_branch:'child',display_title:`CI coverage-v1 · ${merge}`,pull_requests:[{number:2454,head:{sha:head},base:{sha:base,ref:'stack/parent'}}]};
 const previousJob={...f.job,head_sha:head},previousCheck={...f.check,head_sha:head};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[previous]}});
 f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:2,jobs:[previousJob,{...previousJob,id:45,name:'Build production shell',conclusion:'skipped'}]}});
 f.github.rest.checks.get.mockResolvedValue({data:previousCheck});
 await reconcile(f);
 expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:'failure'}));
 expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
 expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ref:'main',inputs:{pr_number:'2454',head_sha:head,base_sha:base,source_sha:merge,execution_mode:'hosted-only'}}));
 expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 // The unchanged tuple is eligible only through the explicit full-hosted marker.
 const fresh={...f.run,id:322,status:'queued',created_at:new Date(Date.now()+1000).toISOString()};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[previous,fresh]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:'failure'}));
 fresh.status='completed';fresh.conclusion='failure';await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:'failure'}));
 fresh.conclusion='success';
 f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:1,jobs:[{...f.job,run_id:322}]}});
 f.github.rest.checks.get.mockResolvedValue({data:{...f.check,details_url:'https://github.com/HamedMP/matrix-os/actions/runs/322/job/44'}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:'success',output:expect.objectContaining({summary:expect.stringContaining('"requestingRunId":322')})}));
 expect(f.github.rest.checks.update).not.toHaveBeenCalled();
});

it.each(['unlabel','switch-off'])('never reuses a previous hosted recovery after re-enable and second %s',async kind=>{
 const f=hostedFixture();const prior=(await f.github.rest.checks.listForRef()).data.check_runs[0];
 f.gateGithub.rest.checks.update.mockImplementation(async(args:any)=>{Object.assign(prior,args);return{data:prior};});
 f.run.created_at=new Date(Date.now()-10000).toISOString();
 const old=JSON.parse(prior.output.summary);prior.output.summary=JSON.stringify({...old,executionMode:'hosted-only',recoveryStartedAt:new Date(Date.now()-20000).toISOString(),recoveryAfterRunId:320});
 await reconcile(f);expect(prior.conclusion).toBe('success');
 f.pull.labels=[{name:'ci-linux'},{name:'ready-for-ci'}];
 const delegated={...f.run,id:400,status:'queued',display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`,created_at:new Date().toISOString()};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[delegated,f.run]}});
 await reconcile(f);expect(prior.conclusion).toBe('failure');
 if(kind==='unlabel')f.pull.labels=[{name:'ready-for-ci'}];else f.github.rest.actions.listRepoVariables.mockResolvedValue({data:{total_count:0,variables:[]}});
 await reconcile(f);expect(prior.conclusion).toBe('failure');expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenLastCalledWith(expect.objectContaining({inputs:expect.objectContaining({execution_mode:'hosted-only'})}));
 expect(JSON.parse(prior.output.summary)).toMatchObject({recoveryAfterRunId:400});
 await reconcile(f);expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
 const fresh={...f.run,id:401,created_at:new Date(Date.now()+1000).toISOString()};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[fresh,delegated,f.run]}});
 f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:1,jobs:[{...f.job,run_id:401}]}});
 f.github.rest.checks.get.mockResolvedValue({data:{...f.check,details_url:'https://github.com/HamedMP/matrix-os/actions/runs/401/job/44'}});
 await reconcile(f);expect(prior.conclusion).toBe('success');expect(JSON.parse(prior.output.summary)).toMatchObject({requestingRunId:401,hostedRecovery:true});
});
it('does not brick source discovery with a newest match in three hundred retained runs',async()=>{
 const f=completeFixture();f.github.rest.actions.listWorkflowRuns.mockImplementation(async(args:any)=>({data:{workflow_runs:[args.workflow_id===98?f.ci:f.controller,...Array.from({length:99},(_,i)=>({...f.controller,id:i+1,event:'schedule',display_title:'old unrelated schedule'}))]}}));
 await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({conclusion:'success'}));
});

it('denies a new delegated admission that races hosted recovery settlement',async()=>{
 const f=hostedFixture();
 f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async()=>{
  const delegated={...f.run,id:400,status:'queued',display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`};
  f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[delegated,f.run]}});
  return{data:{total_count:1,jobs:[f.job]}};
 });
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({conclusion:'failure'}));
});
it('updates an authenticated owned gate without scanning hundreds of unrelated check records',async()=>{
 const f=completeFixture();const prior={id:15,name:'CI Source Qualification',head_sha:head,app:{id:777,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,controllerSha:main,controllerRef:'refs/heads/main',controllerAttempt:1,admittedPreviously:true})}};
 f.github.rest.checks.listForRef.mockResolvedValue({data:{check_runs:[prior,f.check,...Array.from({length:98},(_,i)=>({id:i+20,name:'Unrelated check',head_sha:head,app:{slug:'other'}}))]}});
 await reconcile(f);expect(f.gateGithub.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({check_run_id:15,conclusion:'success'}));
});

it('dispatches immediately when a new Linux admission interrupts pending hosted recovery',async()=>{
 const f=hostedFixture();const prior=(await f.github.rest.checks.listForRef()).data.check_runs[0];
 prior.output.summary=JSON.stringify({...JSON.parse(prior.output.summary),refreshDispatchedAt:new Date().toISOString()});
 const delegated={...f.run,id:400,status:'queued',display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`};
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[delegated,f.run]}});
 await reconcile(f);expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);expect(f.gateGithub.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({conclusion:'failure'}));
});

it('dispatches fresh native source proof retaining direct branchbase and cumulative mergeSHA',async()=>{
 const {nativeStackFixture}=await import('./helpers/native-stack-fixture');const native=nativeStackFixture(),f=fixture(),g:any=f.github;
 g.request=native.github.request;g.rest.pulls=native.github.rest.pulls;g.rest.git=native.github.rest.git;g.rest.repos=native.github.rest.repos;
 await gate.reconcileSourceQualification(g,repo,origin,{runId:123,runAttempt:1,prNumber:native.pull.number,gateAppId:777,gateGithub:f.gateGithub});
 expect(g.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({inputs:{pr_number:String(native.pull.number),head_sha:native.snapshot.headSha,base_sha:native.snapshot.baseSha,source_sha:native.snapshot.sourceSha}}));
});

it('retains ordinary completed source gate success after a newer reconciliation-only controller',async()=>{
 const f=completeFixture();Object.assign(f.ci,{event:'pull_request',head_sha:head,head_branch:'child',display_title:`CI coverage-v1 · ${merge}`,pull_requests:[{number:2454,head:{sha:head},base:{sha:base,ref:'stack/parent'}}]});
 Object.assign(f.controller,{event:'pull_request_target',head_sha:head,head_branch:'child',display_title:`dedicated-ci-v2 pr=2454 head=${head} base=${base} requested=true`});
 const extra={...f.controller,id:125,event:'workflow_run',head_branch:'main',head_sha:main,display_title:`dedicated-refresh-v2 execution=false request=321 title=${f.ci.display_title}`};
 f.github.rest.actions.listWorkflowRuns.mockImplementation(async args=>({data:{workflow_runs:args.workflow_id===98?[f.ci]:[extra,f.controller]}}));
 await reconcile(f);expect(f.gateGithub.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({conclusion:'success'}));
});
