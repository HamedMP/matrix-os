import {verifyIsolatedExecutionOrigin} from './execution-origin.mjs';
import {isolatedRunPin,isolatedControllerMarker,verifyRunExecution} from './dedicated-isolated.mjs';
// Main-definition CI dispatch provides fresh same-head/new-parent coverage.
// Only data is taken from input; privileged helpers never come from the PR.
import {resolveMainSource} from './dedicated-main.mjs';
import {verifyCurrentDedicatedSource,verifyCurrentHostedSource} from './dedicated-admission.mjs';
import {mainPrRunSource,assertMainPrIdentity,waitForCurrentMainSource} from './dedicated-main-pr.mjs';
const sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const request={timeout:10_000};
export const refreshMarker=value=>`CI ${value.executionMode==='hosted-only'?'hosted-refresh-v1':'refresh-v1'} pr=${value.prNumber} head=${value.headSha} base=${value.baseSha} merge=${value.sourceSha??value.mergeSha}`;
export function parseRefreshMarker(title){
 const match=typeof title==='string'&&title.match(/^CI (hosted-refresh-v1|refresh-v1) pr=([1-9][0-9]{0,5}) head=([a-f0-9]{40}) base=([a-f0-9]{40}) merge=([a-f0-9]{40})$/);
 return match?{prNumber:Number(match[2]),headSha:match[3],baseSha:match[4],sourceSha:match[5],...(match[1]==='hosted-refresh-v1'?{executionMode:'hosted-only'}:{})}:null;
}
export function authenticatedRequestingRun(run,repo,value,workflow){
 if(!id(run.id)||run.workflow_id!==workflow.id||![ '.github/workflows/ci.yml','.github/workflows/ci.yml@main','.github/workflows/ci.yml@refs/heads/main'].includes(run.path)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))return false;
 if(value.sourceKind==='main')return run.event==='push'&&run.head_branch==='main'&&run.head_sha===value.headSha&&value.headSha===(value.sourceSha??value.mergeSha)&&run.display_title===`CI coverage-v1 · ${value.sourceSha??value.mergeSha}`;
 if(run.event==='workflow_dispatch')return (run.head_branch==='main'||Boolean(isolatedRunPin(run)))&&sha.test(run.head_sha||'')&&run.display_title===refreshMarker(value);
 // A delegated PR aggregate can be genuinely green with hosted lanes skipped.
 // Rollback requires an explicit main dispatch that forces every hosted lane.
 if(value.executionMode==='hosted-only')return false;
 return run.event==='pull_request'&&run.head_sha===value.headSha&&run.display_title===`CI coverage-v1 · ${value.sourceSha??value.mergeSha}`&&run.pull_requests?.some(pull=>pull.number===value.prNumber&&pull.head?.sha===value.headSha&&(value.baseRef==='main'||pull.base?.sha===value.baseSha)&&pull.base?.ref===value.baseRef)===true;
}
export async function resolveRequestingSource(github,repo,context,inputs){
 let executionOrigin;
 if(context.ref!=='refs/heads/main')executionOrigin=await verifyIsolatedExecutionOrigin(github,repo,context,{workflowPath:'.github/workflows/ci.yml',controllerSha:context.controllerSha});
 else if(!sha.test(context.sha||'')||context.workflowRef!==`${repo.owner}/${repo.repo}/.github/workflows/ci.yml@refs/heads/main`)throw new Error('Fresh CI must use the default main workflow definition');
 const mode=inputs.execution_mode||'linux';if(!['linux','hosted-only'].includes(mode))throw new Error('Invalid requesting execution mode');
 const prNumber=Number(inputs.pr_number);
 if(!id(prNumber)||prNumber>999999||String(prNumber)!==String(inputs.pr_number)||![inputs.head_sha,inputs.base_sha,inputs.source_sha].every(v=>sha.test(v||'')))throw new Error('Invalid exact requesting source inputs');
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:prNumber,request});
 const snapshot={prNumber,headSha:inputs.head_sha,baseSha:inputs.base_sha,sourceSha:inputs.source_sha,baseRef:pull.base?.ref,headRef:pull.head?.ref,...(mode==='hosted-only'?{executionMode:'hosted-only'}:{})};
 const current=await(mode==='hosted-only'?verifyCurrentHostedSource:verifyCurrentDedicatedSource)(github,repo,snapshot);
 snapshot.mergeParents=current.mergeParents;
 if(executionOrigin)snapshot.requesterExecutionOrigin=executionOrigin;
 return snapshot;
}

// Match the protected workflow's execution predicate; reconciliation events
// may refresh the required gate but must not supersede an executing lease.
// GitHub sends one requested event per run but repeated in_progress events as jobs start. A first
// attempt therefore executes only on requested; in_progress is used only for reruns, which emit no
// requested event. Duplicate controllers would otherwise supersede each other under runner backlog.
export function refreshExecutionRequested(action,run){
 // A main push's coverage title is fixed by its SHA, so its requested event qualifies before GitHub renders the title.
 if(action==='requested'&&run?.run_attempt===1&&run?.event==='push'&&run?.head_branch==='main')return true;
 // A manual refresh can still have GitHub's default title in its sole requested event.
 if(action==='requested'&&run?.run_attempt===1&&run?.event==='workflow_dispatch'&&(run?.head_branch==='main'||Boolean(isolatedRunPin(run)))&&run?.display_title==='CI')return true;
 const title=run?.display_title;
 if(typeof title!=='string')return false;
 const executes=title.startsWith('CI refresh-v1 ')||title.startsWith('CI coverage-v1 · ');
 return executes&&((action==='requested'&&run.run_attempt===1)||(action==='in_progress'&&id(run.run_attempt)&&run.run_attempt>1));
}
export function authenticatedControllerRun(run,repo,value,workflow,headRef){
 if(!id(run.id)||run.workflow_id!==workflow.id||!['.github/workflows/ci-dedicated.yml','.github/workflows/ci-dedicated.yml@main','.github/workflows/ci-dedicated.yml@refs/heads/main'].includes(run.path)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))return false;
 if(run.event==='workflow_dispatch'&&isolatedRunPin(run))return value.sourceKind!=="main"&&run.display_title===isolatedControllerMarker(value);
 if(value.sourceKind==='main')return run.event==='workflow_run'&&run.head_branch==='main'&&run.head_sha===value.headSha&&run.display_title===`dedicated-refresh-v2 execution=true request=${value.requestingRunId} title=CI coverage-v1 · ${value.sourceSha??value.mergeSha}`;
 if(run.event==='workflow_run'){
  // The placeholder carries only the requester ID. Grant/receipt validation separately
  // authenticates that requester's rendered exact-source tuple before any workload.
  if(run.head_branch==='main'&&sha.test(run.head_sha||'')&&run.display_title===`dedicated-refresh-v2 execution=true request=${value.requestingRunId} title=CI`)return true;
  return ((run.head_branch==='main'&&sha.test(run.head_sha||''))||(run.head_branch===headRef&&run.head_sha===value.headSha))&&[refreshMarker(value),`CI coverage-v1 · ${value.sourceSha??value.mergeSha}`].some(title=>run.display_title===`dedicated-refresh-v2 execution=true request=${value.requestingRunId} title=${title}`);
 }
 const marker=typeof run.display_title==='string'&&run.display_title.match(/^dedicated-ci-v2 pr=([1-9][0-9]{0,5}) head=([a-f0-9]{40}) base=([a-f0-9]{40}) requested=true$/);
 // The native PTR title records GitHub's stored event base, which can lag the
 // canonical merge's actual parent. Exact source/parents are verified separately
 // at admission, grant and receipt validation; non-main markers stay exact.
 return run.event==='pull_request_target'&&run.head_sha===value.headSha&&run.head_branch===headRef&&!!marker&&Number(marker[1])===value.prNumber&&marker[2]===value.headSha&&(value.baseRef==='main'||marker[3]===value.baseSha);
}
const TITLE_POLLS=12;
const titleDelay=()=>new Promise(resolve=>setTimeout(resolve,10_000));
export async function admitRefreshController(github,repo,event,options={}){
 const candidate=event.workflow_run;
 if(candidate?.display_title?.startsWith('CI hosted-refresh-v1 '))return null;
 if(!refreshExecutionRequested(event.action,candidate)||!id(candidate?.id))return null;
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected refreshing workflow definition');
 let {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:candidate.id,request});
 if(isolatedRunPin(run))await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');
 // Requested can precede the rendered run-name. Bound waiting for main coverage or refresh titles.
 for(let poll=0;(run.event==='push'&&run.head_branch==='main'&&run.display_title!==`CI coverage-v1 · ${run.head_sha}`)||(run.event==='workflow_dispatch'&&run.display_title==='CI');poll++){
  if(poll>=TITLE_POLLS)return null;
  await (options.delay??titleDelay)();
  ({data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:candidate.id,request}));
 }
 if(run.display_title?.startsWith('CI hosted-refresh-v1 '))return null;
 let snapshot=run.event==='push'&&run.head_branch==='main'?await resolveMainSource(github,repo,run.head_sha):parseRefreshMarker(run.display_title);
 if(!snapshot){
  const source=typeof run.display_title==='string'&&run.display_title.match(/^CI coverage-v1 · ([a-f0-9]{40})$/);
  const row=run.pull_requests?.length===1?run.pull_requests[0]:null;
  if(!source||!row)return null;
  if(source&&row)snapshot={prNumber:row.number,headSha:row.head?.sha,baseSha:row.base?.sha,baseRef:row.base?.ref,sourceSha:source[1]};
 }
 if(snapshot?.baseRef==='main'&&run.event==='pull_request'){
  ({snapshot}=await mainPrRunSource(github,repo,run,{...snapshot,headRef:run.head_branch},workflow,{waitForProvenance:true,provenanceDelay:options.provenanceDelay}));
 }
 if(snapshot?.executionMode==='hosted-only')return null;
 if(snapshot&&authenticatedRequestingRun(run,repo,snapshot,workflow))await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');
 if(!snapshot||!authenticatedRequestingRun(run,repo,snapshot,workflow)||!['queued','requested','waiting','pending','in_progress'].includes(run.status))throw new Error('Refresh requester is not currently admitted');
 if(snapshot.sourceKind!=='main'){const {data:pull}=await github.rest.pulls.get({...repo,pull_number:snapshot.prNumber,request});snapshot.baseRef=pull.base.ref;snapshot.headRef=pull.head.ref;if(snapshot.baseRef==='main')assertMainPrIdentity(repo,pull,snapshot,true);if(run.event==='workflow_dispatch'&&snapshot.baseRef==='main'&&pull.merge_commit_sha!==snapshot.sourceSha)await waitForCurrentMainSource(github,repo,snapshot,{delay:options.provenanceDelay});}
 const current=await verifyCurrentDedicatedSource(github,repo,snapshot);
 snapshot.mergeParents=current.mergeParents;
 return snapshot;
}

export async function verifiedRequestingRun(github,repo,run,value,workflow,controllerSha){
 if(!authenticatedRequestingRun(run,repo,value,workflow))return false;
 await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml',controllerSha);return true;
}
export async function verifiedControllerRun(github,repo,run,value,workflow,headRef,controllerSha){
 if(!authenticatedControllerRun(run,repo,value,workflow,headRef))return false;
 await verifyRunExecution(github,repo,run,'.github/workflows/ci-dedicated.yml',controllerSha);return true;
}
