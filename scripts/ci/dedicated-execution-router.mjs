// Trusted Main bridges route work; they never manufacture candidate coverage.
import {dispatchExecutionRef,verifyRunExecution,isolatedControllerMarker,isolatedReconciliationScope} from './dedicated-isolated.mjs';
import {resolveRequestingSource,refreshMarker,refreshExecutionRequested,parseRefreshMarker} from './dedicated-refresh.mjs';
const request={timeout:10_000},sha=/^[a-f0-9]{40}$/;
const same=(name,repo)=>typeof name==='string'&&name.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
function configuration(controllerSha,snapshot){
 if(snapshot?.flag!=='true'||snapshot.pin!==controllerSha||!sha.test(controllerSha||''))throw new Error('Isolated execution configuration changed');
}

async function existing(github,repo,path,ref,title){
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:path,request});
 const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,event:'workflow_dispatch',branch:ref,per_page:100,page:1,request});
 if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>100)throw new Error('Invalid bounded isolated dispatch inventory');
 const run=data.workflow_runs.filter(r=>r.workflow_id===workflow.id&&r.display_title===title&&same(r.repository?.full_name,repo)&&same(r.head_repository?.full_name,repo)).sort((a,b)=>b.id-a.id)[0];
 if(run)await verifyRunExecution(github,repo,run,`.github/workflows/${path}`);
 return run;
}
export async function routeManualCi(github,repo,controllerSha,inputs,snapshot){
 configuration(controllerSha,snapshot);
 if(!/^[1-9][0-9]{0,5}$/.test(inputs.pr_number||'')||![inputs.head_sha,inputs.base_sha,inputs.source_sha].every(v=>sha.test(v||'')))throw new Error('Invalid exact requesting source inputs');
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:Number(inputs.pr_number),request});
 if(pull.state!=='open'||pull.draft===true||pull.head?.sha!==inputs.head_sha||pull.base?.ref!=='main'&&pull.base?.sha!==inputs.base_sha)return{routed:true,stale:true};
 const tuple=await resolveRequestingSource(github,repo,{sha:controllerSha,ref:'refs/heads/main',workflowRef:`${repo.owner}/${repo.repo}/.github/workflows/ci.yml@refs/heads/main`},inputs);
 const ref=await dispatchExecutionRef(github,repo,controllerSha,'.github/workflows/ci.yml');
 const prior=await existing(github,repo,'ci.yml',ref,refreshMarker(tuple));
 if(prior)return{routed:true,runId:prior.id,runAttempt:prior.run_attempt};
 configuration(controllerSha,snapshot);
 await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci.yml',ref,inputs:{pr_number:String(tuple.prNumber),head_sha:tuple.headSha,base_sha:tuple.baseSha,source_sha:tuple.sourceSha,execution_mode:tuple.executionMode==='hosted-only'?'hosted-only':'linux'},request});
 return{routed:true,dispatched:true};
}
export async function routeControllerEvent(github,repo,controllerSha,context,snapshot){
 configuration(controllerSha,snapshot);
 if(context.ref!=='refs/heads/main')throw new Error('Controller bridge must originate on Main');
 let mode,runId,attempt,action;
 if(context.eventName==='workflow_run'){
  const candidate=context.payload.workflow_run;
  const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:candidate.id,request});
  const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
  if(run.id!==candidate.id||run.run_attempt!==candidate.run_attempt)return{dispatched:false,stale:true};
  if(run.workflow_id!==workflow.id||run.path!=='.github/workflows/ci.yml'||!same(run.repository?.full_name,repo))throw new Error('Untrusted controller bridge requester');
  if(!same(run.head_repository?.full_name,repo)){
   // Fork pull_request CI is genuine but cannot receive privileged qualification.
   // Authenticate its workflow/base repository first; other foreign-head events fail closed.
   if(run.event==='pull_request'&&typeof run.head_repository?.full_name==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(run.head_repository.full_name))return{dispatched:false};
   throw new Error('Untrusted controller bridge requester');
  }
  await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');
  if(context.payload.action==='completed'){
   if(run.display_title?.startsWith('CI routing-v1 '))return{dispatched:false};
   if(run.event==='workflow_dispatch'&&run.head_branch==='main'&&!parseRefreshMarker(run.display_title))return{dispatched:false};
   const {data:jobs}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
   if(!Array.isArray(jobs.jobs)||jobs.total_count!==jobs.jobs.length||jobs.jobs.length>100)throw new Error('Incomplete completed requester inventory');
   if(jobs.jobs.some(job=>job.name==='CI Results'&&job.steps?.some(step=>step.name==='Summarize isolated CI routing'&&step.conclusion==='success')))return{dispatched:false};
   mode='reconcile';
  }
  else{
   if(run.event==='push'&&run.head_branch==='main'||run.event==='workflow_dispatch'&&run.head_branch==='main'||!refreshExecutionRequested(context.payload.action,run)||run.display_title.startsWith('CI hosted-refresh-v1 ')||run.display_title.startsWith('CI routing-v1 '))return{dispatched:false};
   mode='qualification';
  }
  runId=run.id;attempt=run.run_attempt;action=context.payload.action;
 }else if(['schedule','push'].includes(context.eventName)){mode='maintenance';runId=context.runId;attempt=context.runAttempt;action='requested';}
 else return{dispatched:false};
 const ref=await dispatchExecutionRef(github,repo,controllerSha,'.github/workflows/ci-dedicated.yml');
 const title=mode==='qualification'?isolatedControllerMarker({requestingRunId:runId,requestingRunAttempt:attempt}):`dedicated-isolated-v1 mode=${mode} request=${runId} attempt=${attempt}`;
 const prior=await existing(github,repo,'ci-dedicated.yml',ref,title);
 if(prior)return{dispatched:false,runId:prior.id,runAttempt:prior.run_attempt};
 const inputs={controller_mode:mode,requesting_run_id:String(runId),requesting_run_attempt:String(attempt),requesting_action:action};
 if(mode!=='qualification'){
  const scope=await isolatedReconciliationScope(github,repo,inputs);
  if(scope.prNumber!==undefined&&(!Number.isSafeInteger(scope.prNumber)||scope.prNumber<1||scope.prNumber>999999))throw new Error('Invalid isolated reconciliation scope');
  inputs.reconciliation_pr=String(scope.prNumber??0);
 }
 configuration(controllerSha,snapshot);
 await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci-dedicated.yml',ref,inputs,request});
 return{dispatched:true,mode};
}
