// Bot-dispatched workflows explicitly hand off; no recursive event is assumed.
import {verifyIsolatedExecutionOrigin} from './execution-origin.mjs';
import {isolatedRunPin,verifyRunExecution} from './dedicated-isolated.mjs';
import {resolveRequestingSource,refreshMarker,parseRefreshMarker} from './dedicated-refresh.mjs';
const path='.github/workflows/ci.yml',request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const active=new Set(['queued','requested','waiting','pending','in_progress']);
function configured(pin,value){
 if(value?.flag!=='true'||value.pin!==pin||!/^[a-f0-9]{40}$/.test(pin||''))throw new Error('Isolated CI handoff configuration changed');
}
function requester(run,workflow,repo,runId,attempt){
 if(!id(workflow?.id)||workflow.path!==path||run?.id!==runId||run.run_attempt!==attempt||run.workflow_id!==workflow.id||run.path!==path||run.event!=='workflow_dispatch'||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo)||!isolatedRunPin(run))throw new Error('Isolated CI requester is not authenticated');
}
async function self(github,repo,context,pin,inputs,configuration){
 configured(pin,configuration);
 if(context?.eventName!=='workflow_dispatch'||!id(context.runId)||!id(context.runAttempt))throw new Error('Isolated CI self identity is invalid');
 const origin=await verifyIsolatedExecutionOrigin(github,repo,context,{workflowPath:path,controllerSha:pin});
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:context.runId,request});
 requester(run,workflow,repo,context.runId,context.runAttempt);
 if(run.head_sha!==context.sha||`refs/heads/${run.head_branch}`!==context.ref||!active.has(run.status))throw new Error('Isolated CI self attempt is no longer active');
 const source=await resolveRequestingSource(github,repo,{...context,controllerSha:pin},inputs);
 if(run.display_title!==refreshMarker(source))throw new Error('Isolated CI source marker does not match');
 return{origin,run,source};
}
export async function requestIsolatedCiQualification(github,repo,context,pin,inputs,configuration){
 const value=await self(github,repo,context,pin,inputs,configuration);
 if(value.source.executionMode==='hosted-only')return{dispatched:false};
 configured(pin,configuration);
 await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci-dedicated.yml',ref:value.origin.executionRef.slice('refs/heads/'.length),inputs:{controller_mode:'qualification',requesting_run_id:String(context.runId),requesting_run_attempt:String(context.runAttempt),requesting_action:context.runAttempt===1?'requested':'in_progress'},request});
 return{dispatched:true};
}
export async function requestIsolatedCiCompletion(github,repo,context,pin,inputs,configuration){
 const value=await self(github,repo,context,pin,inputs,configuration);
 configured(pin,configuration);
 await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci-dedicated.yml',ref:value.origin.executionRef.slice('refs/heads/'.length),inputs:{controller_mode:'reconcile',requesting_run_id:String(context.runId),requesting_run_attempt:String(context.runAttempt),requesting_action:'settling',reconciliation_pr:String(value.source.prNumber)},request});
 return{dispatched:true};
}
export async function awaitTerminalIsolatedRequester(github,repo,inputs,options={}){
 if(inputs.controller_mode!=='reconcile'||inputs.requesting_action!=='settling'||inputs.source_sha||inputs.suite&&inputs.suite!=='qualification')throw new Error('Invalid CI completion handoff');
 const runId=Number(inputs.requesting_run_id),attempt=Number(inputs.requesting_run_attempt);
 if(!id(runId)||!id(attempt)||String(runId)!==inputs.requesting_run_id||String(attempt)!==inputs.requesting_run_attempt||typeof inputs.reconciliation_pr!=='string'||!/^[1-9][0-9]{0,5}$/.test(inputs.reconciliation_pr))throw new Error('Invalid CI completion identity or scope');
 const maximum=options.maxMilliseconds??180_000,now=options.now??Date.now;
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>180_000)throw new Error('Invalid CI completion wait bound');
 const deadline=now()+maximum;
 const delay=options.delay??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
 const signal=AbortSignal.timeout(maximum);
 // Apply the same absolute deadline to every nested origin read, not only polling.
 const boundedCall=call=>async parameters=>{
  const remaining=deadline-now();
  if(remaining<=0)throw new Error('CI completion wait deadline expired');
  const value=await call({...parameters,request:{...parameters.request,timeout:Math.min(10_000,remaining),signal}});
  if(now()>=deadline)throw new Error('CI completion wait deadline expired');
  return value;
 };
 const bounded={rest:{actions:{getWorkflow:boundedCall(parameters=>github.rest.actions.getWorkflow(parameters)),getWorkflowRun:boundedCall(parameters=>github.rest.actions.getWorkflowRun(parameters))},
  repos:{getBranch:boundedCall(parameters=>github.rest.repos.getBranch(parameters)),compareCommitsWithBasehead:boundedCall(parameters=>github.rest.repos.compareCommitsWithBasehead(parameters))},
  git:{getCommit:boundedCall(parameters=>github.rest.git.getCommit(parameters))}}};
 const {data:workflow}=await bounded.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 let origin;
 for(let poll=0;poll<40;poll++){
  const remaining=deadline-now();if(remaining<=0)throw new Error('CI completion requester did not finish within its bound');
  const {data:run}=await bounded.rest.actions.getWorkflowRun({...repo,run_id:runId,request});
  requester(run,workflow,repo,runId,attempt);
  if(!origin||run.status==='completed'){
   const current=await verifyRunExecution(bounded,repo,run,path);
   if(!current||origin&&JSON.stringify(current)!==JSON.stringify(origin))throw new Error('CI completion execution origin changed');
   origin=current;
  }else if(run.head_sha!==origin.executionSha||`refs/heads/${run.head_branch}`!==origin.executionRef)throw new Error('CI completion execution origin changed');
  const tuple=parseRefreshMarker(run.display_title);
  if(!tuple||inputs.reconciliation_pr!==String(tuple.prNumber))throw new Error('CI completion scope does not match its requester');
  if(run.status==='completed'){
   if(typeof run.conclusion!=='string'||!run.conclusion)throw new Error('CI completion has no terminal conclusion');
   if(now()>=deadline)throw new Error('CI completion wait deadline expired');
   return{action:'completed',workflow_run:run};
  }
  if(!active.has(run.status))throw new Error('CI completion requester has an unsupported state');
  const wait=Math.min(5000,deadline-now());if(wait<=0)throw new Error('CI completion wait deadline expired');
  await delay(wait);
 }
 throw new Error('CI completion requester exceeded bounded polling');
}
