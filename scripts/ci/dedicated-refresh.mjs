// Main-definition CI dispatch provides fresh same-head/new-parent coverage.
// Only data is taken from input; privileged helpers never come from the PR.
import {verifyCurrentDedicatedSource} from './dedicated-admission.mjs';
const sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const request={timeout:10_000};
export const refreshMarker=value=>`CI refresh-v1 pr=${value.prNumber} head=${value.headSha} base=${value.baseSha} merge=${value.sourceSha??value.mergeSha}`;
export function parseRefreshMarker(title){
 const match=typeof title==='string'&&title.match(/^CI refresh-v1 pr=([1-9][0-9]{0,5}) head=([a-f0-9]{40}) base=([a-f0-9]{40}) merge=([a-f0-9]{40})$/);
 return match?{prNumber:Number(match[1]),headSha:match[2],baseSha:match[3],sourceSha:match[4]}:null;
}
export function authenticatedRequestingRun(run,repo,value,workflow){
 if(!id(run.id)||run.workflow_id!==workflow.id||![ '.github/workflows/ci.yml','.github/workflows/ci.yml@main','.github/workflows/ci.yml@refs/heads/main'].includes(run.path)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))return false;
 if(run.event==='workflow_dispatch')return run.head_branch==='main'&&sha.test(run.head_sha||'')&&run.display_title===refreshMarker(value);
 return run.event==='pull_request'&&run.head_sha===value.headSha&&run.display_title===`CI coverage-v1 · ${value.sourceSha??value.mergeSha}`&&run.pull_requests?.some(pull=>pull.number===value.prNumber&&pull.head?.sha===value.headSha&&pull.base?.sha===value.baseSha&&pull.base?.ref===value.baseRef)===true;
}
export async function resolveRequestingSource(github,repo,context,inputs){
 if(context.ref!=='refs/heads/main'||!sha.test(context.sha||'')||context.workflowRef!==`${repo.owner}/${repo.repo}/.github/workflows/ci.yml@refs/heads/main`)throw new Error('Fresh CI must use the default main workflow definition');
 const prNumber=Number(inputs.pr_number);
 if(!id(prNumber)||prNumber>999999||String(prNumber)!==String(inputs.pr_number)||![inputs.head_sha,inputs.base_sha,inputs.source_sha].every(v=>sha.test(v||'')))throw new Error('Invalid exact requesting source inputs');
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:prNumber,request});
 const snapshot={prNumber,headSha:inputs.head_sha,baseSha:inputs.base_sha,sourceSha:inputs.source_sha,baseRef:pull.base?.ref,headRef:pull.head?.ref};
 await verifyCurrentDedicatedSource(github,repo,snapshot);
 const {data:merge}=await github.rest.repos.getCommit({...repo,ref:snapshot.sourceSha,request});
 if(merge.sha!==snapshot.sourceSha||merge.parents?.length!==2||merge.parents[0].sha!==snapshot.baseSha||merge.parents[1].sha!==snapshot.headSha)throw new Error('Fresh requesting merge parents changed');
 return snapshot;
}

export function authenticatedControllerRun(run,repo,value,workflow,headRef){
 if(!id(run.id)||run.workflow_id!==workflow.id||!['.github/workflows/ci-dedicated.yml','.github/workflows/ci-dedicated.yml@main','.github/workflows/ci-dedicated.yml@refs/heads/main'].includes(run.path)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))return false;
 if(run.event==='workflow_run')return ((run.head_branch==='main'&&sha.test(run.head_sha||''))||(run.head_branch===headRef&&run.head_sha===value.headSha))&&[refreshMarker(value),`CI coverage-v1 · ${value.sourceSha??value.mergeSha}`].some(title=>run.display_title===`dedicated-refresh-v1 request=${value.requestingRunId} title=${title}`);
 return run.event==='pull_request_target'&&run.head_sha===value.headSha&&run.head_branch===headRef&&run.display_title===`dedicated-ci-v2 pr=${value.prNumber} head=${value.headSha} base=${value.baseSha} requested=true`;
}
export async function admitRefreshController(github,repo,event){
 const candidate=event.workflow_run;
 if(!['requested','in_progress'].includes(event.action)||!id(candidate?.id)||(event.action==='requested'&&!parseRefreshMarker(candidate.display_title)))return null;
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected refreshing workflow definition');
 const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:candidate.id,request});
 if(event.action==='in_progress'&&run.run_attempt===1)return null;
 let snapshot=parseRefreshMarker(run.display_title);
 if(!snapshot&&event.action==='in_progress'&&run.run_attempt>1){
  const source=typeof run.display_title==='string'&&run.display_title.match(/^CI coverage-v1 · ([a-f0-9]{40})$/);
  const row=run.pull_requests?.length===1?run.pull_requests[0]:null;
  if(source&&row)snapshot={prNumber:row.number,headSha:row.head?.sha,baseSha:row.base?.sha,baseRef:row.base?.ref,sourceSha:source[1]};
 }
 if(!snapshot||!authenticatedRequestingRun(run,repo,snapshot,workflow)||!['queued','requested','waiting','pending','in_progress'].includes(run.status))throw new Error('Refresh requester is not currently admitted');
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:snapshot.prNumber,request});
 snapshot.baseRef=pull.base.ref;
 await verifyCurrentDedicatedSource(github,repo,snapshot);
 const {data:commit}=await github.rest.repos.getCommit({...repo,ref:snapshot.sourceSha,request});
 if(commit.sha!==snapshot.sourceSha||commit.parents?.length!==2||commit.parents[0].sha!==snapshot.baseSha||commit.parents[1].sha!==snapshot.headSha)throw new Error('Refresh controller merge parents changed');
 return snapshot;
}
