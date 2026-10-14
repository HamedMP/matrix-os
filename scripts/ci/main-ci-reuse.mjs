// Main reuses the exact PR CI result GitHub tested instead of re-running heavy lanes.
// Under the strict up-to-date ruleset the squash commit on main has the same tree as
// the PR merge commit that PR CI ran. The pinned PR gate records an immutable proof on
// the PR head when it qualifies that merge; once the PR has merged, the live gate check
// is rewritten and the open-PR Linux verifier no longer applies, so the proof is what
// survives. Data mismatches return {reused:false}; API failures throw to the caller.
//
// Reuse also requires the squash parent's own main coverage run to have passed: main
// plans its lanes from the last green coverage commit, so only then does main's plan
// equal the PR's plan for the same diff.
import {parseRefreshMarker} from './dedicated-refresh.mjs';

export const MERGE_QUALIFICATION_CHECK='CI Merge Qualification';
export const GATE_APP_SLUG='matrix-ci-qualification';
const request={timeout:10000},sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const COVERAGE=['linux','infrastructure-hosted','hosted-recovery'];
const IMAGE=/^sha256:[a-f0-9]{64}$/,HARNESS=/^[a-f0-9]{64}$/;
const CI_PATHS=['.github/workflows/ci.yml','.github/workflows/ci.yml@main','.github/workflows/ci.yml@refs/heads/main'];
const evidenceKeys=['schemaVersion','kind','prNumber','headSha','baseSha','sourceSha','requestingRunId','requestingRunAttempt','coverage','controllerSha','imageDigest','harnessDigest'];
const reusedKeys=['prNumber','headSha','mergeSha','tree','requestingRunId','requestingRunAttempt','qualificationCheckId','coverage'];
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const externalId=value=>`merge-qualification-${value.sourceSha}-${value.requestingRunId}-${value.requestingRunAttempt}`;
const MAX_SUMMARY=4096,MAX_PROOFS=100,MAX_RUNS=100;

function validEvidence(value){
 return exactKeys(value,evidenceKeys)&&value.schemaVersion===1&&value.kind==='merge-qualification'&&id(value.prNumber)&&[value.headSha,value.baseSha,value.sourceSha,value.controllerSha].every(v=>sha.test(v||''))&&id(value.requestingRunId)&&id(value.requestingRunAttempt)&&COVERAGE.includes(value.coverage)&&IMAGE.test(value.imageDigest||'')&&HARNESS.test(value.harnessDigest||'');
}

// `qualification` names the controller pin and runner image that produced the result.
export function mergeQualificationEvidence({snapshot,requester,coverage,qualification}){
 const value={schemaVersion:1,kind:'merge-qualification',prNumber:snapshot?.prNumber,headSha:snapshot?.headSha,baseSha:snapshot?.baseSha,sourceSha:snapshot?.sourceSha,requestingRunId:requester?.id,requestingRunAttempt:requester?.run_attempt,coverage,
  controllerSha:qualification?.controllerSha,imageDigest:qualification?.imageDigest,harnessDigest:qualification?.harnessDigest};
 if(!validEvidence(value))throw new Error('Invalid merge qualification evidence');
 return value;
}

export function assertReusedFrom(value){
 if(!exactKeys(value,reusedKeys)||!id(value.prNumber)||![value.headSha,value.mergeSha,value.tree].every(v=>sha.test(v||''))||!id(value.requestingRunId)||!id(value.requestingRunAttempt)||!id(value.qualificationCheckId)||!COVERAGE.includes(value.coverage))throw new Error('Invalid reused PR coverage');
 return value;
}

async function listProofs(github,repo,headSha){
 const {data}=await github.rest.checks.listForRef({...repo,ref:headSha,check_name:MERGE_QUALIFICATION_CHECK,filter:'all',per_page:MAX_PROOFS,request});
 if(!Number.isSafeInteger(data?.total_count)||!Array.isArray(data.check_runs)||data.total_count>MAX_PROOFS||data.check_runs.length!==data.total_count)throw new Error('Merge qualification inventory is incomplete');
 return data.check_runs;
}

// Called by the pinned PR gate right after it qualified the exact merge. Write-once:
// a proof is never updated, so later gate rewrites cannot erase what was qualified.
export async function recordMergeQualification({github,gateGithub,repo,snapshot,requester,coverage,qualification,gateAppId}){
 const value=mergeQualificationEvidence({snapshot,requester,coverage,qualification});
 const external=externalId(value);
 const existing=await listProofs(github,repo,value.headSha);
 if(existing.some(check=>check.app?.id===gateAppId&&check.external_id===external))return {created:false};
 if(existing.length>=MAX_PROOFS)throw new Error('Merge qualification inventory is full');
 const {data:written}=await gateGithub.rest.checks.create({...repo,name:MERGE_QUALIFICATION_CHECK,head_sha:value.headSha,status:'completed',conclusion:'success',external_id:external,request,
  output:{title:'Exact merge qualified for reuse',summary:JSON.stringify(value)}});
 if(written?.app?.id!==gateAppId)throw new Error('Merge qualification issuer response mismatch');
 return {created:true,checkId:written.id};
}

const fromGate=(check,gateAppId)=>gateAppId===undefined?check.app?.slug===GATE_APP_SLUG:check.app?.id===gateAppId;

function parseProof(check,gateAppId){
 if(!fromGate(check,gateAppId)||!id(check.id)||check.name!==MERGE_QUALIFICATION_CHECK||check.status!=='completed'||check.conclusion!=='success')return null;
 const summary=check.output?.summary;
 if(typeof summary!=='string'||Buffer.byteLength(summary)>MAX_SUMMARY)return null;
 let value;
 try{value=JSON.parse(summary);}catch(error){if(!(error instanceof SyntaxError))throw error;return null;}
 if(!validEvidence(value)||check.head_sha!==value.headSha||check.external_id!==externalId(value))return null;
 return value;
}

async function commitOf(github,repo,ref){
 const {data}=await github.rest.repos.getCommit({...repo,ref,request});
 if(data?.sha!==ref||!Array.isArray(data.parents)||!sha.test(data.commit?.tree?.sha||''))throw new Error('Invalid commit proof');
 return {parents:data.parents.map(parent=>parent.sha),tree:data.commit.tree.sha};
}

const ciRun=(run,full)=>CI_PATHS.includes(run?.path)&&same(run.repository?.full_name,full)&&same(run.head_repository?.full_name,full);
const testsMerge=(run,proof)=>run.event==='pull_request'?run.head_sha===proof.headSha&&run.display_title===`CI coverage-v1 · ${proof.sourceSha}`
 :run.event==='workflow_dispatch'&&run.head_branch==='main'&&(marker=>marker?.prNumber===proof.prNumber&&marker.headSha===proof.headSha&&marker.baseSha===proof.baseSha&&marker.sourceSha===proof.sourceSha)(parseRefreshMarker(run.display_title));

async function runsAfter(github,repo,filter,createdAt){
 const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:'ci.yml',...filter,created:`>=${createdAt}`,per_page:MAX_RUNS,request});
 if(!Number.isSafeInteger(data?.total_count)||!Array.isArray(data.workflow_runs)||data.total_count>MAX_RUNS||data.workflow_runs.length!==data.total_count)throw new Error('CI run history is incomplete');
 return data.workflow_runs;
}

// The exact CI attempt the proof names must be a genuine successful ci.yml run for this
// PR snapshot, still its run's latest attempt, not superseded by a newer run for the same
// merge, and carry a GitHub Actions-issued CI Results aggregate.
async function genuineRequestingRun(github,repo,proof){
 const full=`${repo.owner}/${repo.repo}`;
 const {data:run}=await github.rest.actions.getWorkflowRunAttempt({...repo,run_id:proof.requestingRunId,attempt_number:proof.requestingRunAttempt,request});
 if(run?.id!==proof.requestingRunId||run.run_attempt!==proof.requestingRunAttempt||run.status!=='completed'||run.conclusion!=='success'||!ciRun(run,full)||!testsMerge(run,proof)||!run.created_at)return false;
 const {data:latest}=await github.rest.actions.getWorkflowRun({...repo,run_id:run.id,request});
 if(latest?.id!==run.id||latest.run_attempt!==run.run_attempt)return false;
 const newer=[...await runsAfter(github,repo,{event:'pull_request',head_sha:proof.headSha},run.created_at),...await runsAfter(github,repo,{event:'workflow_dispatch',branch:'main'},run.created_at)];
 if(newer.some(other=>other.id>run.id&&ciRun(other,full)&&testsMerge(other,proof)))return false;
 const {data}=await github.rest.actions.listJobsForWorkflowRunAttempt({...repo,run_id:run.id,attempt_number:run.run_attempt,per_page:100,request});
 if(!Number.isSafeInteger(data?.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)return false;
 const aggregates=data.jobs.filter(job=>job.name==='CI Results');
 if(aggregates.length!==1)return false;
 const [job]=aggregates,prefix=`https://api.github.com/repos/${full}/check-runs/`;
 if(job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'||!job.check_run_url?.startsWith(prefix))return false;
 const checkId=Number(job.check_run_url.slice(prefix.length));if(!id(checkId))return false;
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 return check?.id===checkId&&check.name==='CI Results'&&check.app?.slug==='github-actions'&&check.head_sha===run.head_sha&&check.status==='completed'&&check.conclusion==='success'&&check.details_url?.startsWith(`https://github.com/${full}/actions/runs/${run.id}/`);
}

async function parentCoverageGreen(github,repo,parent){
 const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:'ci.yml',event:'push',branch:'main',head_sha:parent,per_page:20,request});
 const full=`${repo.owner}/${repo.repo}`;
 return Array.isArray(data?.workflow_runs)&&data.workflow_runs.some(run=>run.head_sha===parent&&run.status==='completed'&&run.conclusion==='success'&&ciRun(run,full)&&run.display_title===`CI coverage-v1 · ${parent}`);
}

// `qualification` is the current controller pin and runner image: proofs from any other
// configuration never qualify main. `gateAppId` pins the exact App when the caller has it
// (the pinned main gate); ci.yml cannot read the environment-scoped id and relies on the
// globally unique App slug. `frontier` is main's recorded coverage base when known, and
// `checkId` re-verifies exactly the proof a decision receipt named.
export async function resolveReusablePrCoverage(github,repo,mainSha,{gateAppId,qualification,frontier,checkId}={}){
 if(!sha.test(mainSha||''))throw new Error('Invalid main commit');
 if(!sha.test(qualification?.controllerSha||'')||!IMAGE.test(qualification?.imageDigest||'')||!HARNESS.test(qualification?.harnessDigest||''))throw new Error('Reuse requires the current qualification configuration');
 const main=await commitOf(github,repo,mainSha);
 if(main.parents.length!==1)return {reused:false,reason:'main commit is not a single-parent squash'};
 const [parent]=main.parents,full=`${repo.owner}/${repo.repo}`;
 if(frontier&&(frontier.bootstrap!==false||frontier.coverageBaseSha!==parent))return {reused:false,reason:'main coverage frontier is not the squash parent'};
 if(!await parentCoverageGreen(github,repo,parent))return {reused:false,reason:'main coverage frontier is not the squash parent'};
 const {data:pulls}=await github.rest.repos.listPullRequestsAssociatedWithCommit({...repo,commit_sha:mainSha,per_page:100,request});
 const merged=(Array.isArray(pulls)?pulls:[]).filter(pull=>id(pull.number)&&pull.merged_at&&pull.merge_commit_sha===mainSha&&pull.base?.ref==='main'&&same(pull.base?.repo?.full_name,full)&&same(pull.head?.repo?.full_name,full)&&sha.test(pull.head?.sha||''));
 if(merged.length!==1)return {reused:false,reason:'no single merged PR for the main commit'};
 const [pull]=merged;
 const proofs=(await listProofs(github,repo,pull.head.sha)).filter(check=>checkId===undefined||check.id===checkId).map(check=>({check,value:parseProof(check,gateAppId)}))
  .filter(({value})=>value&&value.prNumber===pull.number&&value.headSha===pull.head.sha&&value.baseSha===parent
   &&value.controllerSha===qualification.controllerSha&&value.imageDigest===qualification.imageDigest&&value.harnessDigest===qualification.harnessDigest)
  .sort((a,b)=>b.check.id-a.check.id);
 for(const {check,value} of proofs){
  const tested=await commitOf(github,repo,value.sourceSha);
  if(tested.tree!==main.tree||tested.parents.length!==2||tested.parents[0]!==parent||tested.parents[1]!==pull.head.sha)continue;
  if(!await genuineRequestingRun(github,repo,value))return {reused:false,reason:'qualified PR run is not a genuine successful CI run'};
  return {reused:true,reusedFrom:assertReusedFrom({prNumber:pull.number,headSha:pull.head.sha,mergeSha:value.sourceSha,tree:main.tree,requestingRunId:value.requestingRunId,requestingRunAttempt:value.requestingRunAttempt,qualificationCheckId:check.id,coverage:value.coverage})};
 }
 return {reused:false,reason:'no merge qualification matches the squash'};
}
