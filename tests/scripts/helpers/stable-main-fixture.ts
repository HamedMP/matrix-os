import {vi} from 'vitest';
import {pinArtifactFixture} from './dedicated-artifact-fixture';

export const pins={head:'a'.repeat(40),base:'b'.repeat(40),source:'c'.repeat(40),controller:'d'.repeat(40),advanced:'e'.repeat(40),newSource:'f'.repeat(40)};
export const repo={owner:'HamedMP',repo:'matrix-os'};
export function stableMainFixture(){
 const {head,base,source,controller,advanced,newSource}=pins;
 const pull={number:2454,state:'open',draft:false,labels:[{name:'fast-ci'},{name:'ready-for-ci'}],head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'main',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:source};
 let main=base;
 const origin={sha:controller,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
 const ci={id:321,created_at:'2026-10-18T12:00:00Z',run_attempt:1,workflow_id:98,event:'pull_request',path:'.github/workflows/ci.yml',head_sha:head,head_branch:'child',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},status:'in_progress',conclusion:null as string|null,pull_requests:[{number:2454,head:{sha:head},base:{sha:base,ref:'main'}}],display_title:`CI coverage-v1 · ${source}`};
 const run={...ci,id:124,created_at:'2026-10-18T11:59:30Z',workflow_id:99,event:'pull_request_target',path:'.github/workflows/ci-dedicated.yml',pull_requests:[],display_title:`dedicated-ci-v2 pr=2454 head=${head} base=${base} requested=true`};
 const summary={schemaVersion:3,prNumber:2454,suite:'qualification',headSha:head,baseSha:base,baseRef:'main',sourceSha:source,controllerSha:controller,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',controllerAttempt:1,requestingRunId:321,requestingRunAttempt:1,mode:'delegated',imageDigest:'sha256:'+'1'.repeat(64),harnessDigest:'2'.repeat(64),receiptVerified:true,requestDigest:'9'.repeat(64),leaseId:'8'.repeat(32)};
 const check={id:12,name:'Dedicated CI Results',head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/124',output:{summary:JSON.stringify(summary)}};
 const aggregate={id:33,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',app:{id:15368,slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/321/job/30'};
 const job={id:30,run_id:321,run_attempt:1,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/33'};
 const provenance={id:13,name:'CI Source Qualification',head_sha:head,app:{id:5271502,slug:'matrix-ci-gate'},status:'completed',conclusion:'success',details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,prNumber:2454,headSha:head,headRef:'child',baseRef:'main',baseSha:base,sourceSha:source,controllerSha:controller,controllerRef:'refs/heads/main',controllerAttempt:1,sourceBindings:[{baseSha:base,sourceSha:source}]})}};
 const github={rest:{
  pulls:{get:vi.fn(async()=>({data:pull})),list:vi.fn(async()=>({data:[pull]}))},
  repos:{getBranch:vi.fn(async({branch}:{branch:string})=>({data:{name:branch,commit:{sha:main}}})),getCommit:vi.fn(async({ref}:{ref:string})=>({data:{sha:ref,parents:[{sha:ref===newSource?advanced:base},{sha:head}]}})),compareCommitsWithBasehead:vi.fn(async({basehead}:{basehead:string})=>({data:{status:'ahead',merge_base_commit:{sha:basehead.split('...')[0]}}}))},
  checks:{listForRef:vi.fn(async({check_name}:{check_name:string})=>({data:{check_runs:check_name==='CI Source Qualification'?[provenance]:[check]}})),get:vi.fn(async()=>({data:aggregate})),update:vi.fn(async()=>({data:{}}))},
  actions:{getWorkflow:vi.fn(async({workflow_id}:{workflow_id:string})=>({data:{id:workflow_id==='ci.yml'?98:99,path:'.github/workflows/'+workflow_id}})),getWorkflowRun:vi.fn(async({run_id}:{run_id:number})=>({data:run_id===321?ci:run_id===124?run:{...run,id:123,event:'schedule',head_branch:'main',head_sha:controller}})),listWorkflowRuns:vi.fn(async({workflow_id}:{workflow_id:number})=>({data:{workflow_runs:workflow_id===98?[ci]:[run]}})),listRepoVariables:vi.fn(async()=>({data:{total_count:6,variables:Object.entries({MATRIX_CI_CONTROLLER_SHA:controller,MATRIX_CI_DEDICATED_ENABLED:'true',MATRIX_CI_DEDICATED_MAIN:'false',MATRIX_CI_DEDICATED_SHADOW:'true',MATRIX_CI_RUNNER_IMAGE_DIGEST:summary.imageDigest,MATRIX_CI_RUNNER_HARNESS_DIGEST:summary.harnessDigest}).map(([name,value])=>({name,value}))}})),createWorkflowDispatch:vi.fn(),listWorkflowRunArtifacts:vi.fn(async()=>({data:{artifacts:[{name:`dedicated-qualification-${head}-${source}-${base}-pr2454-request321-1-attempt1`,id:55,expired:false,size_in_bytes:2000,workflow_run:{id:124}}]}})),listJobsForWorkflowRun:vi.fn(async({run_id}:{run_id:number})=>({data:run_id===321?{total_count:1,jobs:[job]}:{jobs:[{name:'benchmark',status:'completed',conclusion:'success'}]}}))}
 }};
 const receipt=pinArtifactFixture(github,check,run);
 const gateGithub={rest:{checks:{create:vi.fn(async(args:any)=>({data:{id:10,...args,app:{id:5271502}}})),update:vi.fn(async(args:any)=>({data:{id:args.check_run_id,name:'CI Source Qualification',head_sha:head,...args,app:{id:5271502}}}))}}};
 const snapshot={prNumber:2454,headSha:head,headRef:'child',baseSha:base,baseRef:'main',sourceSha:source};
 return {pull,origin,ci,run,check,provenance,aggregate,github,gateGithub,snapshot,request:receipt.request,
  advance(){main=advanced;pull.base.sha=advanced;pull.merge_commit_sha=newSource;},
  complete(){run.status='completed';run.conclusion='success';ci.status='completed';ci.conclusion='success';}};
}
