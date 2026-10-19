import {describe,expect,it,vi} from 'vitest';
import {verifyMetadataCoverage} from '../../scripts/ci/metadata-result.mjs';
const repo={owner:'HamedMP',repo:'matrix-os'},head='2'.repeat(40),base='9'.repeat(40),source='b'.repeat(40);
const snapshot={prNumber:2575,headSha:head,baseSha:base,sourceSha:source,baseRef:'main',headRef:'child'};
function fixture(){
 const run={id:20,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'pull_request',head_sha:head,head_branch:'child',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:`CI coverage-v1 · ${source}`,pull_requests:[{number:2575,head:{sha:head},base:{sha:base,ref:'main'}}],status:'completed',conclusion:'success'};
 const check={id:33,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',app:{id:15368,slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/20/job/30'};
 const job={id:30,run_id:20,run_attempt:1,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/33'};
 const pull={number:2575,state:'open',draft:false,head:{sha:head,ref:'child',repo:run.head_repository},base:{sha:base,ref:'main',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:source};
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull}))},repos:{getCommit:vi.fn(async()=>({data:{sha:source,parents:[{sha:base},{sha:head}]}})),getBranch:vi.fn(async()=>({data:{name:'main',commit:{sha:base}}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[run]}})),listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[job]}}))},checks:{get:vi.fn(async()=>({data:check}))}}};return{github,run,check,job,pull};
}
describe('metadata edits verify genuine exact-source coverage',()=>{
 it('keeps a passed first-attempt PR green through repeated title/body edits without a head or base update',async()=>{
  const f=fixture();for(const id of [21,22])expect(await verifyMetadataCoverage(f.github,repo,snapshot,id)).toEqual({runId:20,runAttempt:1,sourceSha:source,baseSha:base});
 });
 it.each(['failure','cancelled',null])('never replaces a %s prior CI result with green',async conclusion=>{
  const f=fixture();f.run.conclusion=conclusion as any;await expect(verifyMetadataCoverage(f.github,repo,snapshot,21)).rejects.toThrow();
 });
 it.each(['head','base','merge','metadata','missing','pending','check-app','check-sha','attempt','skipped'])('fails closed for %s mismatch',async kind=>{
  const f=fixture();if(kind==='head')f.run.head_sha='a'.repeat(40);if(kind==='base')f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:source,parents:[{sha:base},{sha:'a'.repeat(40)}]}});if(kind==='merge')f.run.display_title=`CI coverage-v1 · ${'a'.repeat(40)}`;if(kind==='metadata')f.run.display_title=`CI metadata-v1 · ${source}`;
  if(kind==='missing')f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[]}});if(kind==='pending')f.run.status='in_progress';if(kind==='check-app')f.check.app.id=1;if(kind==='check-sha')f.check.head_sha='a'.repeat(40);if(kind==='attempt')f.job.run_attempt=2;if(kind==='skipped')f.check.conclusion='skipped';
  await expect(verifyMetadataCoverage(f.github,repo,snapshot,21)).rejects.toThrow();
 });
 it('does not fall back from a newer failed genuine CI to an older success',async()=>{
  const f=fixture();f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[{...f.run,id:22,conclusion:'failure'},f.run]}});await expect(verifyMetadataCoverage(f.github,repo,snapshot,23)).rejects.toThrow();
 });
 it('propagates API denial rather than reporting success',async()=>{const f=fixture();f.github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error('denied'));await expect(verifyMetadataCoverage(f.github,repo,snapshot,21)).rejects.toThrow('denied');});
});

it('authenticates fork metadata against the event head repository without trusting an arbitrary issuer',async()=>{
 const f=fixture();f.run.head_repository.full_name='contributor/matrix-os';
 const fork={...snapshot,headRepository:'contributor/matrix-os'};
 expect(await verifyMetadataCoverage(f.github,repo,fork,21)).toEqual({runId:20,runAttempt:1,sourceSha:source,baseSha:base});
 f.run.head_repository.full_name='attacker/matrix-os';await expect(verifyMetadataCoverage(f.github,repo,fork,21)).rejects.toThrow();
});

it('executes the actual GitHub workflow metadata step against the real verifier',async()=>{
 const {readFileSync}=await import('node:fs'),{parse}=await import('yaml'),{spawnSync}=await import('node:child_process');
 const workflow=parse(readFileSync('.github/workflows/ci.yml','utf8'));
 const script=workflow.jobs['ci-results'].steps.find((step:any)=>step.name==='Verify exact-source coverage after metadata edit').with.script;
 const f=fixture();
 const context={repo,sha:source,runId:21,payload:{pull_request:{number:2575,head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'main'}}}};
 // Execute in a native process: Vitest's VM cannot import dynamically from
 // AsyncFunction, while actions/github-script uses Node's native implementation.
 const program=`
  import {createRequire} from 'node:module';
  import assert from 'node:assert/strict';
  const f=${JSON.stringify({run:f.run,check:f.check,job:f.job})};
  const github={rest:{pulls:{get:async()=>({data:${JSON.stringify(f.pull)}})},repos:{getCommit:async()=>({data:{sha:'${source}',parents:[{sha:'${base}'},{sha:'${head}'}]}}),getBranch:async()=>({data:{name:'main',commit:{sha:'${base}'}}})},actions:{getWorkflow:async()=>({data:{id:98,path:'.github/workflows/ci.yml'}}),listWorkflowRuns:async()=>({data:{workflow_runs:[f.run]}}),listJobsForWorkflowRun:async()=>({data:{total_count:1,jobs:[f.job]}})},checks:{get:async()=>({data:f.check})}}};
  const messages=[],summary={addRaw(value){messages.push(value);return this;},async write(){}};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const runStep=new AsyncFunction('require','github','context','core',${JSON.stringify(script)});
  const invoke=()=>runStep(createRequire(import.meta.url),github,${JSON.stringify(context)},{summary});
  await invoke();assert.match(messages[0],/tested-source CI run 20, attempt 1/);
  f.check.conclusion='failure';await assert.rejects(invoke());assert.equal(messages.length,1);
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:10000,env:{...process.env,GITHUB_WORKSPACE:process.cwd()}});
 expect(result.status,result.stderr).toBe(0);
});

it('accepts exact-source full-hosted recovery and never falls back past its newer failed attempt',async()=>{
 const f=fixture();Object.assign(f.run,{event:'workflow_dispatch',head_branch:'main',head_sha:base,display_title:`CI hosted-refresh-v1 pr=2575 head=${head} base=${base} merge=${source}`});
 f.job.head_sha=base;f.check.head_sha=base;
 expect(await verifyMetadataCoverage(f.github,repo,snapshot,21)).toEqual({runId:20,runAttempt:1,sourceSha:source,baseSha:base});
 f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[{...f.run,id:22,conclusion:'failure'},f.run]}});
 await expect(verifyMetadataCoverage(f.github,repo,snapshot,23)).rejects.toThrow();
});

it('binds an empty fork association to the live PR source, and rejects changed source or identity',async()=>{
 const f=fixture();f.run.head_repository.full_name='contributor/matrix-os';f.run.pull_requests=[];
 const pull={number:2575,state:'open',draft:false,head:{sha:head,ref:'child',repo:{full_name:'contributor/matrix-os'}},base:{sha:base,ref:'main',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:source};
 Object.assign(f.github.rest,{pulls:{get:vi.fn(async()=>({data:pull}))},repos:{...f.github.rest.repos,getCommit:vi.fn(async()=>({data:{sha:source,parents:[{sha:base},{sha:head}]}}))}});
 const fork={...snapshot,headRepository:'contributor/matrix-os'};
 expect(await verifyMetadataCoverage(f.github,repo,fork,21)).toEqual({runId:20,runAttempt:1,sourceSha:source,baseSha:base});
 pull.head.sha='a'.repeat(40);await expect(verifyMetadataCoverage(f.github,repo,fork,21)).rejects.toThrow();
 pull.head.sha=head;pull.head.repo.full_name='attacker/matrix-os';await expect(verifyMetadataCoverage(f.github,repo,fork,21)).rejects.toThrow();
});

function isolatedMetadataFixture(baseRef:string){
 const f=fixture(),pin='a'.repeat(40),execution='c'.repeat(40),tree='d'.repeat(40);
 f.pull.base.ref=baseRef;f.run.pull_requests[0]!.base.ref=baseRef;
 const isolated={...f.run,id:22,event:'workflow_dispatch',head_sha:execution,head_branch:`ci-execution/${pin}`,
  head_repository:{...f.run.head_repository},pull_requests:[],display_title:`CI refresh-v1 pr=2575 head=${head} base=${base} merge=${source}`};
 const isolatedJob={...f.job,id:31,run_id:22,head_sha:execution,check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/34'};
 const isolatedCheck={...f.check,id:34,head_sha:execution,details_url:'https://github.com/HamedMP/matrix-os/actions/runs/22/job/31'};
 const commits:Record<string,{sha:string;tree:{sha:string};parents:{sha:string}[]}>= {
  [pin]:{sha:pin,tree:{sha:tree},parents:[]},[execution]:{sha:execution,tree:{sha:tree},parents:[{sha:pin}]},
 };
 const github={rest:{...f.github.rest,
  git:{getCommit:vi.fn(async({commit_sha}:{commit_sha:string})=>({data:commits[commit_sha]}))},
  repos:{...f.github.rest.repos,
   getBranch:vi.fn(async({branch}:{branch:string})=>({data:{name:branch,commit:{sha:branch==='main'?base:execution}}})),
   compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'ahead',merge_base_commit:{sha:pin}}})),
  },
  actions:{...f.github.rest.actions,
   // Respect the real API branch/event filters: an omitted isolated stream must
   // not accidentally see its rows through an unrealistically broad fixture.
   listWorkflowRuns:vi.fn(async({event,branch}:{event:string;branch:string})=>({data:{workflow_runs:
    event==='pull_request'&&branch==='child'?[f.run]:event==='workflow_dispatch'&&branch===isolated.head_branch?[isolated]:[]}})),
   listJobsForWorkflowRun:vi.fn(async({run_id}:{run_id:number})=>({data:{total_count:1,jobs:[run_id===22?isolatedJob:f.job]}})),
  },
  checks:{get:vi.fn(async({check_run_id}:{check_run_id:number})=>({data:check_run_id===34?isolatedCheck:f.check}))},
 }};
 return{github,isolated,commits,pin,execution,snapshot:{...snapshot,baseRef,executionControllerSha:pin}};
}

describe.each(['main','stack/parent'])('isolated metadata coverage for %s',baseRef=>{
 it('uses the newest authenticated isolated coverage and its actual execution aggregate',async()=>{
  const f=isolatedMetadataFixture(baseRef);
  expect(await verifyMetadataCoverage(f.github,repo,f.snapshot,23)).toEqual({runId:22,runAttempt:1,sourceSha:source,baseSha:base});
  expect(f.github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({event:'workflow_dispatch',branch:`ci-execution/${f.pin}`}));
  expect(f.github.rest.git.getCommit).toHaveBeenCalledWith(expect.objectContaining({commit_sha:f.execution}));
  expect(f.github.rest.checks.get).toHaveBeenCalledWith(expect.objectContaining({check_run_id:34}));
 });
 it.each(['failure','in_progress'])('does not reuse older green PR coverage when newer isolated coverage is %s',async state=>{
  const f=isolatedMetadataFixture(baseRef);
  if(state==='failure')f.isolated.conclusion='failure';else f.isolated.status='in_progress';
  await expect(verifyMetadataCoverage(f.github,repo,f.snapshot,23)).rejects.toThrow('No successful exact-source CI coverage');
  expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 });
 it('rejects a changed isolated execution tree before reusing any green result',async()=>{
  const f=isolatedMetadataFixture(baseRef);f.commits[f.execution]!.tree.sha='e'.repeat(40);
  await expect(verifyMetadataCoverage(f.github,repo,f.snapshot,23)).rejects.toThrow('Execution tree differs');
  expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 });
});
