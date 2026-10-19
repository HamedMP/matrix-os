import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {receiptFor,receiptZip,artifactDownloadApi} from './helpers/dedicated-artifact-fixture';

const repo={owner:'HamedMP',repo:'matrix-os'},pin='a'.repeat(40),execution='e'.repeat(40),tree='f'.repeat(40);
const head='b'.repeat(40),base='c'.repeat(40),source='d'.repeat(40),branch=`ci-execution/${pin}`;
const inputs={execution_mode:'linux',pr_number:'2454',head_sha:head,base_sha:base,source_sha:source};
const configuration={pin,flag:'true',imageDigest:'sha256:'+'6'.repeat(64),harnessDigest:'7'.repeat(64),linuxRequired:true,backendProvider:'linux',backendInfrastructureFallback:false};
const module=()=>import('../../scripts/ci/dedicated-ci-handoff.mjs');

// All completion assertions use the production result verifier and an actual
// versioned immutable archive. Nothing injects a successful waiter result.
function fixture(attempt=2){
 const repository={id:1157069949,full_name:'HamedMP/matrix-os'};
 const run={id:321,run_attempt:attempt,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_branch:branch,head_sha:execution,
  status:'in_progress',conclusion:null as string|null,created_at:'2026-10-18T12:00:00Z',repository,head_repository:repository,
  display_title:`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${source}`};
 const pull={number:2454,state:'open',draft:false,head:{sha:head,ref:'feature/source',repo:repository},base:{sha:base,ref:'main',repo:repository},merge_commit_sha:source,labels:[{name:'ready-for-ci'},{name:'fast-ci'}]};
 const context={eventName:'workflow_dispatch',ref:`refs/heads/${branch}`,sha:execution,workflowRef:`HamedMP/matrix-os/.github/workflows/ci.yml@refs/heads/${branch}`,workflowSha:execution,runId:321,runAttempt:attempt,payload:{inputs,repository}};
 const backend={id:401,name:'Isolated CI Backend Decision',run_id:321,run_attempt:attempt,head_sha:execution,head_branch:branch,status:'in_progress',conclusion:null as string|null};
 const origin={schemaVersion:1,controllerSha:pin,controllerRef:'refs/heads/main',executionRef:`refs/heads/${branch}`,executionSha:execution,executionWorkflowSha:execution,workflowPath:'.github/workflows/ci-dedicated.yml',treeSha:tree};
 const controller={...run,id:654,run_attempt:1,workflow_id:99,path:'.github/workflows/ci-dedicated.yml',status:'completed',conclusion:'success',created_at:'2026-10-18T12:00:01Z',display_title:`dedicated-isolated-v1 mode=qualification request=321 attempt=${attempt}`};
 const summary={schemaVersion:4,suite:'qualification',prNumber:2454,headSha:head,baseSha:base,baseRef:'main',sourceSha:source,
  controllerRunId:654,controllerAttempt:1,controllerSha:pin,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',
  requestingRunId:321,requestingRunAttempt:attempt,imageDigest:configuration.imageDigest,harnessDigest:configuration.harnessDigest,mode:'delegated',receiptVerified:true,leaseId:'8'.repeat(32),executionOrigin:origin};
 const receipt=receiptFor(summary,654,[base,head]);
 const check={id:777,name:'Dedicated CI Results',head_sha:head,status:'completed',conclusion:'success',app:{slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/654',output:{summary:JSON.stringify({...summary,requestDigest:receipt.requestDigest})}};
 const envelope={schemaVersion:2,executionOrigin:origin,receipt};
 const artifact={id:55,name:`dedicated-qualification-${head}-${source}-${base}-pr2454-request321-${attempt}-attempt1`,expired:false,size_in_bytes:1,digest:'',workflow_run:{id:654,head_sha:execution}};
 const state={jobs:[backend]};
 const github:any={rest:{
  actions:{getWorkflow:vi.fn(async({workflow_id}:any)=>({data:{id:workflow_id==='ci.yml'?98:99,path:`.github/workflows/${workflow_id}`}})),
   getWorkflowRun:vi.fn(async({run_id}:any)=>({data:run_id===321?run:controller})),
   listWorkflowRuns:vi.fn(async(args:any)=>({data:{workflow_runs:(args.workflow_id===98?[run]:[controller]).filter(value=>(!args.event||value.event===args.event)&&(!args.branch||value.head_branch===args.branch)&&(!args.head_sha||value.head_sha===args.head_sha))}})),
   listJobsForWorkflowRun:vi.fn(async({run_id}:any)=>({data:{total_count:run_id===321?state.jobs.length:1,jobs:run_id===321?state.jobs:[{id:888,name:'benchmark',run_id:654,run_attempt:1,head_sha:execution,status:'completed',conclusion:'success'}]}})),
   listWorkflowRunArtifacts:vi.fn(async()=>({data:{total_count:1,artifacts:[artifact]}})),
   createWorkflowDispatch:vi.fn(async()=>({status:204})),downloadArtifact:vi.fn(),
  },
  repos:{getBranch:vi.fn(async({branch:requested}:any)=>({data:{name:requested,commit:{sha:requested===branch?execution:base}}})),
   getCommit:vi.fn(async({ref}:any)=>({data:{sha:ref,parents:[{sha:base},{sha:head}],commit:{tree:{sha:tree}}}})),
   compareCommitsWithBasehead:vi.fn(async({basehead}:any)=>({data:{status:'ahead',merge_base_commit:{sha:basehead.split('...')[0]}}})),
  },git:{getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))},
  pulls:{get:vi.fn(async()=>({data:pull}))},checks:{listForRef:vi.fn(async()=>({data:{check_runs:[check]}}))},apps:{createInstallationAccessToken:vi.fn()},
 }};
 const pinReceipt=()=>{
  const bytes=receiptZip(envelope);artifact.size_in_bytes=bytes.length;artifact.digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  github.rest.actions.downloadArtifact=vi.fn(artifactDownloadApi(bytes));
 };
 pinReceipt();
 return{github,run,pull,context,backend,backendAttempt:attempt as number|undefined,controller,check,envelope,artifact,state,pinReceipt};
}

const complete=(f:ReturnType<typeof fixture>,config:any={...configuration,backendAttempt:f.backendAttempt})=>(module()).then(value=>value.requestIsolatedCiCompletion(f.github,repo,f.context,pin,inputs,config));
const modes=(f:ReturnType<typeof fixture>)=>f.github.rest.actions.createWorkflowDispatch.mock.calls.map(([args]:any[])=>args.inputs.controller_mode);
// GitHub materializes retained successful jobs with the latest API attempt and
// a new ID. The protected job output retains the attempt that actually executed.
function retainedSuccess(){const f=fixture();f.backendAttempt=1;Object.assign(f.backend,{status:'completed',conclusion:'success'});return f;}

describe('completion ownership under whole and failed-job retries',()=>{
 it.each([1,2])('the executing backend explicitly requests qualification for its own attempt %s without relying on automatic events',async attempt=>{
  const f=fixture(attempt);
  await (await module()).requestIsolatedCiQualification(f.github,repo,f.context,pin,inputs,configuration);
  expect(modes(f)).toEqual(['qualification']);
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({ref:branch,inputs:expect.objectContaining({requesting_run_id:'321',requesting_run_attempt:String(attempt),requesting_action:attempt===1?'requested':'in_progress'})}));
 });
 it('requalifies an API-cloned retained successful backend for the current attempt before posting completion',async()=>{
  const f=retainedSuccess();
  expect(await complete(f)).toEqual({dispatched:true,attempt:2,qualificationDispatched:true});
  expect(modes(f)).toEqual(['qualification','reconcile']);
  const calls=f.github.rest.actions.createWorkflowDispatch.mock.calls;
  expect(calls.every(([args]:any[])=>args.ref===branch&&args.inputs.requesting_run_id==='321'&&args.inputs.requesting_run_attempt==='2')).toBe(true);
  expect(calls[1][0].inputs).toMatchObject({requesting_action:'settling',reconciliation_pr:'2454'});
  expect(f.github.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({run_id:321,filter:'latest',per_page:100}));
  expect(f.github.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(expect.objectContaining({run_id:654}));
  expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
  expect(f.github.rest.actions.downloadArtifact.mock.invocationCallOrder[0]).toBeLessThan(f.github.rest.actions.createWorkflowDispatch.mock.invocationCallOrder[1]);
  expect(f.github.rest.apps.createInstallationAccessToken).not.toHaveBeenCalled();
 });
 it.each(['success','failure','cancelled','timed_out'])('does not redispatch a current-attempt backend after its actual %s',async conclusion=>{
  const f=fixture();Object.assign(f.backend,{status:'completed',conclusion});
  expect(await complete(f)).toEqual({dispatched:true,attempt:2,qualificationDispatched:false});
  expect(modes(f)).toEqual(['reconcile']);
  if(conclusion==='success')expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
  else expect(f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
 });
 it.each(['failure','cancelled','timed_out'])('settles an actual current %s backend even when it emitted no successful output',async conclusion=>{
  const f=fixture();f.backendAttempt=undefined;Object.assign(f.backend,{status:'completed',conclusion});
  expect(await complete(f)).toEqual({dispatched:true,attempt:2,qualificationDispatched:false});
  expect(modes(f)).toEqual(['reconcile']);expect(f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
 });
 it.each([undefined,0,-1,1.5,NaN,3,'1'])('rejects invalid successful backend output attempt %j before any dispatch',async value=>{
  const f=fixture();Object.assign(f.backend,{status:'completed',conclusion:'success'});
  await expect(complete(f,{...configuration,backendAttempt:value})).rejects.toThrow();
  expect(modes(f)).toEqual([]);expect(f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
 });
 it.each(['missing','duplicate','id','run-id','future-attempt','old-api-attempt','invalid-attempt','head-sha','head-branch','running','old-failure','old-cancelled','truncated','oversized'])(
  'rejects %s backend ownership metadata before any new dispatch',async kind=>{
   const f=retainedSuccess();
   if(kind==='missing')f.state.jobs=[];
   if(kind==='duplicate')f.state.jobs.push({...f.backend,id:402});
   if(kind==='id')f.backend.id=0;if(kind==='run-id')f.backend.run_id=322;
   if(kind==='future-attempt')f.backend.run_attempt=3;if(kind==='old-api-attempt')f.backend.run_attempt=1;if(kind==='invalid-attempt')f.backend.run_attempt=0;
   if(kind==='head-sha')f.backend.head_sha=pin;if(kind==='head-branch')f.backend.head_branch='main';
   if(kind==='running')f.backend.status='in_progress';if(kind==='old-failure')f.backend.conclusion='failure';if(kind==='old-cancelled')f.backend.conclusion='cancelled';
   if(kind==='truncated')f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:2,jobs:[f.backend]}});
   if(kind==='oversized')f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:101,jobs:Array.from({length:101},(_,i)=>({...f.backend,id:401+i,name:i===0?f.backend.name:`unrelated-${i}`}))}});
   await expect(complete(f)).rejects.toThrow();
   expect(modes(f)).toEqual([]);expect(f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });
 it.each((['retained','current'] as const).flatMap(owner=>['envelope-version','envelope-origin','request-source','digest'].map(kind=>({owner,kind}))))(
  'requires a genuine current-attempt immutable receipt for $owner backend: $kind',async({owner,kind})=>{
   const f=owner==='retained'?retainedSuccess():fixture();Object.assign(f.backend,{status:'completed',conclusion:'success'});
   if(kind==='envelope-version')f.envelope.schemaVersion=1;
   if(kind==='envelope-origin')f.envelope.executionOrigin={...f.envelope.executionOrigin,executionSha:pin};
   if(kind==='request-source')f.envelope.receipt.sourceSha=pin;
   f.pinReceipt();if(kind==='digest')f.artifact.digest='sha256:'+'0'.repeat(64);
   await expect(complete(f)).rejects.toThrow();
   expect(modes(f)).toEqual(owner==='retained'?['qualification']:[]);
   expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
  });
 it('does not accept proved infrastructure unavailability as full retained-backend qualification',async()=>{
  const f=retainedSuccess(),summary=JSON.parse(f.check.output.summary);
  Object.assign(summary,{receiptVerified:false,outcome:'infrastructure-unavailable',status:76,reason:'queue_timeout',stage:'admission',workloadStarted:false,containerGone:true});
  f.envelope.receipt=receiptFor(summary,654,[base,head]);
  f.check.conclusion='neutral';f.check.output.summary=JSON.stringify({...summary,requestDigest:f.envelope.receipt.requestDigest});f.pinReceipt();
  await expect(complete(f)).rejects.toThrow();
  expect(modes(f)).toEqual(['qualification']);expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
 });
 it('preserves verified infrastructure fallback from a successful current backend without redispatch',async()=>{
  const f=fixture(),summary=JSON.parse(f.check.output.summary);Object.assign(f.backend,{status:'completed',conclusion:'success'});
  Object.assign(summary,{receiptVerified:false,outcome:'infrastructure-unavailable',status:76,reason:'queue_timeout',stage:'admission',workloadStarted:false,containerGone:true});
  f.envelope.receipt=receiptFor(summary,654,[base,head]);
  f.check.conclusion='neutral';f.check.output.summary=JSON.stringify({...summary,requestDigest:f.envelope.receipt.requestDigest});f.pinReceipt();
  expect(await complete(f,{...configuration,backendAttempt:f.backendAttempt,backendProvider:'hosted',backendInfrastructureFallback:true})).toEqual({dispatched:true,attempt:2,qualificationDispatched:false});
  expect(modes(f)).toEqual(['reconcile']);expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
 });
 it.each(['linux','hosted'])('does not accept current infrastructure proof without a protected %s fallback decision',async backendProvider=>{
  const f=fixture(),summary=JSON.parse(f.check.output.summary);Object.assign(f.backend,{status:'completed',conclusion:'success'});
  Object.assign(summary,{receiptVerified:false,outcome:'infrastructure-unavailable',status:76,reason:'queue_timeout',stage:'admission',workloadStarted:false,containerGone:true});
  f.envelope.receipt=receiptFor(summary,654,[base,head]);
  f.check.conclusion='neutral';f.check.output.summary=JSON.stringify({...summary,requestDigest:f.envelope.receipt.requestDigest});f.pinReceipt();
  await expect(complete(f,{...configuration,backendAttempt:f.backendAttempt,backendProvider,backendInfrastructureFallback:false})).rejects.toThrow();
  expect(modes(f)).toEqual([]);expect(f.github.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
 });
 it.each(['image','harness','required-boolean'])(
  'validates %s configuration before dispatching retained-backend work',async kind=>{
   const f=retainedSuccess(),config:any={...configuration,backendAttempt:f.backendAttempt};
   if(kind==='image')config.imageDigest='latest';if(kind==='harness')config.harnessDigest='bad';if(kind==='required-boolean')config.linuxRequired='true';
   await expect(complete(f,config)).rejects.toThrow();expect(modes(f)).toEqual([]);
  });
 it('posts completion without qualification or backend ownership reads for hosted/docs work',async()=>{
  const f=fixture();f.state.jobs=[];
  expect(await complete(f,{...configuration,linuxRequired:false})).toEqual({dispatched:true,attempt:2,qualificationDispatched:false});
  expect(modes(f)).toEqual(['reconcile']);expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 });
 it.each(['source','actual-attempt','origin'])(
  'retains full self authentication before a completion ownership decision: %s',async kind=>{
   const f=retainedSuccess();
   if(kind==='source')f.pull.head.sha=pin;if(kind==='actual-attempt')f.run.run_attempt=3;if(kind==='origin')f.context.workflowSha=pin;
   await expect(complete(f)).rejects.toThrow();expect(modes(f)).toEqual([]);
   expect(f.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
  });
});
