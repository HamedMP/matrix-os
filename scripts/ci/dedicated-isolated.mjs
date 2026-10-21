// An isolated run executes the reviewed controller tree on a distinct commit.
// Its logical source authority is Main; actual execution origin stays explicit.
import {executionBranch,executionControllerSha,verifyIsolatedExecutionOrigin,verifyIsolatedExecutionRun} from './execution-origin.mjs';
const request={timeout:10_000},sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
export const isolatedRunPin=run=>executionControllerSha(`refs/heads/${run?.head_branch??''}`);
export const isolatedControllerMarker=value=>`dedicated-isolated-v1 mode=qualification request=${value.requestingRunId} attempt=${value.requestingRunAttempt}`;
export class InactiveIsolatedRequester extends Error {}
export async function verifyRunExecution(github,repo,run,workflowPath,controllerSha){
 const pin=isolatedRunPin(run);
 if(!pin){if(String(run?.head_branch??'').startsWith('ci-execution/'))throw new Error('Malformed isolated execution branch');return null;}
 if(controllerSha!==undefined&&pin!==controllerSha)throw new Error('Isolated execution source pin changed');
 return verifyIsolatedExecutionRun(github,repo,run,{workflowPath,controllerSha:pin,workflowId:run.workflow_id});
}
export async function verifiedSourceController(github,repo,controller,executionContext){
 if(!executionContext)throw new Error('Actual isolated execution context is required');
 const origin=await verifyIsolatedExecutionOrigin(github,repo,executionContext,{workflowPath:'.github/workflows/ci-dedicated.yml',controllerSha:controller.sha});
 return{...controller,executionOrigin:origin};
}
export async function isolatedTrigger(github,repo,inputs,mode){
 if(inputs.controller_mode!==mode||!['qualification','reconcile','maintenance'].includes(mode)||inputs.source_sha||inputs.suite&&inputs.suite!=='qualification')throw new Error('Invalid isolated controller mode');
 const runId=Number(inputs.requesting_run_id),attempt=Number(inputs.requesting_run_attempt),action=inputs.requesting_action;
 if(!id(runId)||!id(attempt)||String(runId)!==inputs.requesting_run_id||String(attempt)!==inputs.requesting_run_attempt)throw new Error('Invalid isolated requester identity');
 const path=mode==='maintenance'?'ci-dedicated.yml':'ci.yml';
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:path,request});
 const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:runId,request});
 if(!id(workflow.id)||workflow.path!==`.github/workflows/${path}`||run.id!==runId||!id(run.run_attempt)||run.workflow_id!==workflow.id||run.path!==workflow.path||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))throw new Error('Isolated requester is not authenticated');
 if(mode==='qualification'){
  if(!['requested','in_progress'].includes(action)||(action==='requested'?attempt!==1:attempt<=1)||run.run_attempt<attempt||run.event==='push')throw new Error('Isolated qualification requester is stale or unsupported');
  if(run.run_attempt>attempt||run.status==='completed')throw new InactiveIsolatedRequester('Isolated qualification requester is no longer active');
  if(!['queued','requested','waiting','pending','in_progress'].includes(run.status))throw new Error('Isolated qualification requester is stale or unsupported');
 }else if(mode==='reconcile'){
  if(run.run_attempt!==attempt||!['completed','settling'].includes(action)||run.status!=='completed'||!['pull_request','workflow_dispatch','push'].includes(run.event))throw new Error('Isolated completion requester is not terminal');
 }else if(run.run_attempt!==attempt||action!=='requested'||!['schedule','push'].includes(run.event)||run.head_branch!=='main'||!sha.test(run.head_sha||''))throw new Error('Isolated maintenance needs an authenticated Main scheduler');
 return{action,workflow_run:run};
}
export async function isolatedReconciliationScope(github,repo,inputs){
 const mode=inputs.controller_mode,event=await isolatedTrigger(github,repo,inputs,mode),run=event.workflow_run;
 if(mode==='maintenance'||run.event==='push'&&run.head_branch==='main')return{};
 if(run.event==='workflow_dispatch'){
  const {parseRefreshMarker}=await import('./dedicated-refresh.mjs');const tuple=parseRefreshMarker(run.display_title);
  if(!tuple)throw new Error('Completed refresh has no exact source marker');
  await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');
  return{prNumber:tuple.prNumber};
 }
 const rows=run.pull_requests;
 if(!Array.isArray(rows))throw new Error('Completed requester has no authenticated PR scope');
 // Authenticated ordinary completions without a unique PR retain the full scan.
 if(rows.length!==1)return{};
 if(!id(rows[0]?.number)||![rows[0].head?.repo?.url,rows[0].base?.repo?.url].every(url=>String(url).toLowerCase()===`https://api.github.com/repos/${repo.owner}/${repo.repo}`.toLowerCase()))throw new Error('Completed requester has no authenticated PR scope');
 return{prNumber:rows[0].number};
}
export async function validatedIsolatedReconciliationScope(github,repo,inputs){
 const scope=await isolatedReconciliationScope(github,repo,inputs),hint=inputs.reconciliation_pr;
 if(typeof hint!=='string'||!/^(?:0|[1-9][0-9]{0,5})$/.test(hint)||hint!==String(scope.prNumber??0))throw new Error('Invalid isolated reconciliation scope hint');
 return scope;
}
export {executionBranch};
export async function dispatchExecutionRef(github,repo,controllerSha,workflowPath){
 const branch=executionBranch(controllerSha),ref=`refs/heads/${branch}`;
 const {data}=await github.rest.repos.getBranch({...repo,branch,request});
 const executionSha=data.commit?.sha;
 await verifyIsolatedExecutionOrigin(github,repo,{ref,sha:executionSha,workflowRef:`${repo.owner}/${repo.repo}/${workflowPath}@${ref}`,workflowSha:executionSha},{workflowPath,controllerSha});
 return branch;
}
export function assertNotRoutingCoverage(jobs){
 if(jobs.some(job=>job.name==='CI Results'&&job.steps?.some(step=>step.name==='Summarize isolated CI routing'&&step.status==='completed'&&step.conclusion==='success')))throw new Error('Routing-only workflow cannot provide candidate coverage');
}
