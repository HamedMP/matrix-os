// Metadata suites must execute the required Actions job. A skipped/renamed job
// in a newer suite makes GitHub show the previous real result as "Expected".
// Reuse only a genuine aggregate for the identical head/base/merge snapshot;
// metadata verifications themselves are never requesting coverage candidates.
import {authenticatedRequestingRun} from './dedicated-refresh.mjs';
import {newestWorkflowRun} from './dedicated-history.mjs';
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
function requestingRun(run,repo,snapshot,workflow){
 const expected=snapshot.headRepository??`${repo.owner}/${repo.repo}`;
 // Fork CI is unprivileged pull_request coverage. Pin its head repository to
 // GitHub's event snapshot, then use the same source/workflow authentication.
 if(run.event==='pull_request'){
  if(typeof expected!=='string'||run.head_repository?.full_name?.toLowerCase()!==expected.toLowerCase())return false;
  const emptyFork=!same(expected,`${repo.owner}/${repo.repo}`)&&Array.isArray(run.pull_requests)&&run.pull_requests.length===0&&run.head_branch===snapshot.headRef;
  const associations=emptyFork?[{number:snapshot.prNumber,head:{sha:snapshot.headSha},base:{sha:snapshot.baseSha,ref:snapshot.baseRef}}]:run.pull_requests;
  return authenticatedRequestingRun({...run,head_repository:{full_name:`${repo.owner}/${repo.repo}`},pull_requests:associations},repo,snapshot,workflow);
 }
 return authenticatedRequestingRun(run,repo,snapshot,workflow)||authenticatedRequestingRun(run,repo,{...snapshot,executionMode:'hosted-only'},workflow);
}
export async function verifyMetadataCoverage(github,repo,snapshot,currentRunId){
 if(!id(currentRunId)||!id(snapshot.prNumber)||![snapshot.headSha,snapshot.baseSha,snapshot.sourceSha].every(value=>/^[a-f0-9]{40}$/.test(value||''))||!snapshot.headRef||!snapshot.baseRef)throw new Error('Invalid metadata source snapshot');
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected CI workflow');
 const run=await newestWorkflowRun(github,repo,workflow,candidate=>candidate.id!==currentRunId&&requestingRun(candidate,repo,snapshot,workflow),{kind:'requester',headSha:snapshot.headSha,headRef:snapshot.headRef});
 if(!run||run.status!=='completed'||run.conclusion!=='success')throw new Error('No successful exact-source CI coverage for this metadata edit');
 if(run.event==='pull_request'&&run.pull_requests?.length===0){
  // GitHub omits associations for fork runs. Independently authenticate the
  // event's exact PR tuple and public merge parents before accepting that shape.
  const {data:pull}=await github.rest.pulls.get({...repo,pull_number:snapshot.prNumber,request});
  if(pull.number!==snapshot.prNumber||pull.state!=='open'||pull.draft!==false||pull.head?.sha!==snapshot.headSha||pull.head?.ref!==snapshot.headRef||!same(pull.head?.repo?.full_name,snapshot.headRepository)||!same(pull.base?.repo?.full_name,`${repo.owner}/${repo.repo}`)||pull.base?.sha!==snapshot.baseSha||pull.base?.ref!==snapshot.baseRef||pull.merge_commit_sha!==snapshot.sourceSha)throw new Error('Fork metadata source changed');
  const {data:merge}=await github.rest.repos.getCommit({...repo,ref:snapshot.sourceSha,request});
  if(merge.sha!==snapshot.sourceSha||JSON.stringify(merge.parents?.map(parent=>parent.sha))!==JSON.stringify([snapshot.baseSha,snapshot.headSha]))throw new Error('Fork metadata merge binding mismatch');
 }

 const {data}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
 if(!Number.isSafeInteger(data.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)throw new Error('Incomplete genuine CI job inventory');
 const aggregates=data.jobs.filter(job=>job.name==='CI Results');
 const job=aggregates[0],prefix=`https://api.github.com/repos/${repo.owner}/${repo.repo}/check-runs/`;
 if(aggregates.length!==1||job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'||!job.check_run_url?.startsWith(prefix))throw new Error('Genuine CI aggregate did not pass');
 const checkId=Number(job.check_run_url.slice(prefix.length));
 if(!id(checkId))throw new Error('Invalid genuine CI check identity');
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 if(check.id!==checkId||check.app?.id!==15368||check.app?.slug!=='github-actions'||check.name!=='CI Results'||check.head_sha!==run.head_sha||check.status!=='completed'||check.conclusion!=='success'||check.details_url!==`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}/job/${job.id}`)throw new Error('CI aggregate issuer or source binding mismatch');
 return{runId:run.id,runAttempt:run.run_attempt};
}
