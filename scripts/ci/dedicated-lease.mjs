// Called after host lock and before each renewal, using only controller-owned
// code and the GitHub token kept on the authenticated default-branch runner.
import {assertDefaultController,verifyCurrentDedicatedSource} from './dedicated-admission.mjs';
import {authenticatedRequestingRun,authenticatedControllerRun} from './dedicated-refresh.mjs';
import {verifyControllerPin} from './dedicated-pin.mjs';
import {readReviewedConfiguration} from './dedicated-api.mjs';
import {newestWorkflowRun} from './dedicated-history.mjs';
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const workflowPath=name=>`.github/workflows/${name}`;
const active=run=>['queued','requested','waiting','pending','in_progress'].includes(run.status);
async function requestingRuns(github,repo,value,workflow){
 const run=await newestWorkflowRun(github,repo,workflow,run=>authenticatedRequestingRun(run,repo,value,workflow),{kind:'requester',headSha:value.headSha,headRef:value.headRef});
 return run?[run]:[];
}
async function newestControllerRun(github,repo,value,workflow,headRef){
 return newestWorkflowRun(github,repo,workflow,run=>authenticatedControllerRun(run,repo,value,workflow,headRef),{kind:'controller',headSha:value.headSha,headRef});
}
export async function newestRequestingCiRun(github,repo,value,mode){
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!==workflowPath('ci.yml'))throw new Error('Unexpected requesting CI definition');
 const run=(await requestingRuns(github,repo,value,workflow))[0];
 if(!run||!id(run.run_attempt)||(!active(run)&&!(mode==='shadow'&&run.status==='completed'&&run.conclusion==='success')))throw new Error('No current requesting CI run is admitted');
 return{runId:run.id,runAttempt:run.run_attempt};
}
export async function verifyDedicatedLeaseGrant(github,repo,controller,value){
 assertDefaultController(repo,controller);
 const configuration=await readReviewedConfiguration(github,repo);
 await verifyControllerPin(github,repo,controller.sha,configuration);
 if(value.controllerSha!==controller.sha||value.controllerRef!==controller.ref||value.controllerWorkflow!==workflowPath('ci-dedicated.yml')||!['shadow','delegated'].includes(value.mode)||![value.requestingRunId,value.requestingRunAttempt,value.controllerRunId,value.controllerRunAttempt].every(id))throw new Error('Invalid controller/requesting lease identity');
 for(const [name,expected] of [['MATRIX_CI_RUNNER_IMAGE_DIGEST',value.imageDigest],['MATRIX_CI_RUNNER_HARNESS_DIGEST',value.harnessDigest],[value.mode==='delegated'?'MATRIX_CI_DEDICATED_ENABLED':'MATRIX_CI_DEDICATED_SHADOW','true']]){
  if(configuration[name]!==expected)throw new Error('Reviewed Linux configuration changed or mode disabled');
 }
 const pull=await verifyCurrentDedicatedSource(github,repo,{prNumber:value.prNumber,headSha:value.headSha,baseSha:value.baseSha,baseRef:value.baseRef,sourceSha:value.mergeSha,mergeParents:value.mergeParents});
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
 if(!id(workflow.id)||workflow.path!==workflowPath('ci-dedicated.yml'))throw new Error('Unexpected controller definition');
 const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:value.controllerRunId,request});
 if(!authenticatedControllerRun(run,repo,value,workflow,pull.head.ref)||run.id!==value.controllerRunId||run.run_attempt!==value.controllerRunAttempt||!active(run))throw new Error('Current controller attempt is no longer admitted');
 const newest=await newestControllerRun(github,repo,value,workflow,pull.head.ref);
 if(!newest||newest.id!==value.controllerRunId||newest.run_attempt!==value.controllerRunAttempt)throw new Error('A newer controller superseded this lease');
 const {data:ciWorkflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(ciWorkflow.id)||ciWorkflow.path!==workflowPath('ci.yml'))throw new Error('Unexpected requesting CI definition');
 const {data:ciRun}=await github.rest.actions.getWorkflowRun({...repo,run_id:value.requestingRunId,request});
 if(!authenticatedRequestingRun(ciRun,repo,value,ciWorkflow)||ciRun.id!==value.requestingRunId||ciRun.run_attempt!==value.requestingRunAttempt||(ciRun.event==='pull_request'&&ciRun.head_branch!==pull.head.ref)||(!active(ciRun)&&!(value.mode==='shadow'&&ciRun.status==='completed'&&ciRun.conclusion==='success')))throw new Error('Current requesting CI attempt is no longer admitted');
 const latest=(await requestingRuns(github,repo,value,ciWorkflow))[0];
 if(!latest||latest.id!==value.requestingRunId||latest.run_attempt!==value.requestingRunAttempt)throw new Error('A newer requesting CI attempt superseded this lease');
}
