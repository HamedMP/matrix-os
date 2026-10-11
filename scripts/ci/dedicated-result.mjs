// Read-only GitHub API evidence verification. Never execute controller artifacts.
import {verifyCurrentDedicatedSource} from './dedicated-admission.mjs';
import {authenticatedControllerRun} from './dedicated-refresh.mjs';
import {createConditionalGithub} from './dedicated-api.mjs';
const workflowPath = '.github/workflows/ci-dedicated.yml';
const trustedRunPath = value => [workflowPath, `${workflowPath}@main`, `${workflowPath}@refs/heads/main`].includes(value);
const shaPattern = /^[a-f0-9]{40}$/;
const request = {timeout: 10_000};
const sameRepo = (value, expected) => typeof value === 'string' && value.toLowerCase() === `${expected.owner}/${expected.repo}`.toLowerCase();
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function parseEvidence(check, expected) {
  if (!positiveId(check.id) || check.name !== 'Dedicated CI Results' || check.head_sha !== expected.headSha ||
      check.app?.slug !== 'github-actions' || !['queued','in_progress','completed'].includes(check.status)) return null;
  const prefix = `${expected.serverUrl}/${expected.owner}/${expected.repo}/actions/runs/`;
  if (typeof check.details_url !== 'string' || !check.details_url.startsWith(prefix)) return null;
  const id = check.details_url.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !positiveId(Number(id))) return null;
  const summary = check.output?.summary;
  if (typeof summary !== 'string' || summary.length > 4096) return null;
  let evidence;
  try { evidence = JSON.parse(summary); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!evidence || evidence.schemaVersion !== 3 || evidence.suite !== 'qualification' ||
      evidence.sourceSha !== expected.sourceSha || evidence.headSha !== expected.headSha ||
      evidence.baseSha !== expected.baseSha || evidence.baseRef !== expected.baseRef ||
      evidence.prNumber !== expected.prNumber || !positiveId(evidence.controllerAttempt) ||
      !shaPattern.test(evidence.controllerSha || '') || evidence.controllerRef !== 'refs/heads/main' ||
      evidence.controllerWorkflow !== workflowPath || evidence.requestingRunId!==expected.requestingRunId ||
      evidence.requestingRunAttempt!==expected.requestingRunAttempt || evidence.imageDigest!==expected.imageDigest ||
      evidence.harnessDigest!==expected.harnessDigest || evidence.mode!==expected.mode ||
      (check.status==='completed'&&(evidence.receiptVerified!==true || !/^[a-f0-9]{64}$/.test(evidence.requestDigest||'') || !/^[a-f0-9]{32}$/.test(evidence.leaseId||'')))) return null;
  return {...evidence, runId:Number(id)};
}

const requestMarker = expected => `dedicated-ci-v2 pr=${expected.prNumber} head=${expected.headSha} base=${expected.baseSha} requested=true`;
// REST run head_* fields describe the PR candidate, not the executable workflow
// definition. Default origin is enforced by GitHub's pull_request_target contract,
// the registered workflow ID/path and the controller's main ref/workflow_ref guard.
// Never compare candidate head_sha to the controller SHA reported by its check.
function trustedController(run, expected, workflow) {
  return positiveId(run.run_attempt)&&authenticatedControllerRun(run,{owner:expected.owner,repo:expected.repo},expected,workflow,expected.headRef);
}

async function newestRequest(github, repo, expected, workflow) {
  // Run identity exists before environment approval/runner admission creates a
  // check. A queued retry must prevent an older result from settling this PR.
  const candidates=[];
  for(let page=1;page<=3;page++) {
    const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,
      per_page:100,page,request});
    const runs=data.workflow_runs;
    if(!Array.isArray(runs) || runs.length>100)throw new Error('Invalid bounded controller run list');
    candidates.push(...runs.filter(run=>trustedController(run,expected,workflow)));
    if(runs.length<100)break;
    if(page===3)throw new Error('Controller history exceeds bounded coverage');
  }
  candidates.sort((a,b)=>b.id-a.id || b.run_attempt-a.run_attempt);
  return candidates[0];
}

async function newestController(github, repo, expected, workflow, latest) {
  if(!latest)return undefined;
  // At most 300 checks per poll; authenticate only the newest current-attempt
  // check for the newest source request, then discard the scoped array.
  const candidates=[];
  for(let page=1;page<=3;page++) {
    const {data}=await github.rest.checks.listForRef({...repo,ref:expected.headSha,per_page:100,page,filter:'all',request});
    const checks=data.check_runs ?? [];
    if(!Array.isArray(checks) || checks.length>100)throw new Error('Invalid bounded check list');
    for(const check of checks) {
      const evidence=parseEvidence(check,expected);
      if(evidence?.runId===latest.id && evidence.controllerAttempt===latest.run_attempt)candidates.push({check,evidence});
    }
    if(checks.length<100)break;
    if(page===3)throw new Error('Source check history exceeds bounded coverage');
  }
  candidates.sort((a,b)=>b.check.id-a.check.id);
  const selected=candidates[0];
  if(!selected)return undefined;
  const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:latest.id,request});
  if(!trustedController(run,expected,workflow) || run.id!==latest.id ||
      run.run_attempt!==selected.evidence.controllerAttempt)return undefined;
  return {...selected,run};
}

export async function waitForDedicatedResult(github,expected,options={}) {
  const maximum=options.maxMilliseconds??3_900_000;
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>3_900_000)throw new Error('Invalid waiter deadline');
  const aborter=new AbortController();let timer;
  try{return await Promise.race([waitWithinDeadline(github,expected,{...options,signal:aborter.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{aborter.abort();reject(new Error('No verified dedicated Linux qualification completed within the bounded wait'));},maximum);timer.unref?.();})]);}
  finally{clearTimeout(timer);aborter.abort();}
}
async function waitWithinDeadline(github, expected, options={}) {
  if(![expected.requestingRunId,expected.requestingRunAttempt].every(positiveId)||
      !/^sha256:[a-f0-9]{64}$/.test(expected.imageDigest||'')||!/^[a-f0-9]{64}$/.test(expected.harnessDigest||'')||!['shadow','delegated'].includes(expected.mode)||
      ![expected.headSha,expected.baseSha,expected.sourceSha].every(sha=>shaPattern.test(sha || '')) ||
      !positiveId(expected.prNumber) || typeof expected.baseRef!=='string' || !expected.baseRef ||
      typeof expected.headRef!=='string' || !expected.headRef) {
    throw new Error('Invalid dedicated qualification revision');
  }
  const api=createConditionalGithub(github,{authenticationContext:`requester-${expected.requestingRunId}-${expected.requestingRunAttempt}`,signal:options.signal});github=api.github;
  const maxAttempts=options.maxAttempts ?? 130;
  if(!Number.isSafeInteger(maxAttempts) || maxAttempts<1 || maxAttempts>130)throw new Error('Invalid wait bound');
  const delay=options.delay ?? (()=>new Promise(resolve=>setTimeout(resolve,30_000)));
  const repo={owner:expected.owner,repo:expected.repo};
  const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
  if(workflow.path!==workflowPath)throw new Error('Unexpected dedicated controller workflow');
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    await verifyCurrentDedicatedSource(github,repo,expected);
    const latest=await newestRequest(github,repo,expected,workflow);
    if(latest?.status==='completed' && latest.conclusion!=='success') {
      throw new Error('Verified dedicated Linux qualification failed');
    }
    const selected=await newestController(github,repo,expected,workflow,latest);
    if(selected?.run.status==='completed') {
      const {check,evidence,run}=selected;
      if(run.conclusion!=='success' || (check.status==='completed' && check.conclusion!=='success')) {
        throw new Error('Verified dedicated Linux qualification failed');
      }
      if(check.status==='completed') {
        const artifactName=`dedicated-qualification-${expected.headSha}-${expected.sourceSha}-${expected.baseSha}-pr${expected.prNumber}-request${expected.requestingRunId}-${expected.requestingRunAttempt}-attempt${evidence.controllerAttempt}`;
        const {data:artifactData}=await github.rest.actions.listWorkflowRunArtifacts({...repo,run_id:evidence.runId,per_page:100,request});
        const provenance=artifactData.artifacts?.find(artifact=>artifact.name===artifactName);
        if(provenance && !provenance.expired && provenance.workflow_run?.id===evidence.runId &&
            Number.isSafeInteger(provenance.size_in_bytes) && provenance.size_in_bytes>=1 && provenance.size_in_bytes<=16384) {
          const {data:jobData}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:evidence.runId,per_page:100,filter:'latest',request});
          const dispatch=jobData.jobs?.find(job=>job.name==='benchmark');
          if(dispatch?.status==='completed') {
            if(dispatch.conclusion!=='success')throw new Error('Verified dedicated Linux qualification failed');
            const current=await newestRequest(github,repo,expected,workflow);
            if(current?.status==='completed' && current.conclusion!=='success') {
              throw new Error('Verified dedicated Linux qualification failed');
            }
            // A retry may have been queued while artifacts/jobs were fetched.
            if(current?.id===run.id && current.run_attempt===run.run_attempt &&
                current.head_sha===run.head_sha && current.status==='completed' && current.conclusion==='success') {
              await verifyCurrentDedicatedSource(github,repo,expected);
              options.metrics?.(api.metrics());
              return {runId:evidence.runId,sourceSha:expected.sourceSha};
            }
          }
        }
      }
    }
    if(attempt+1<maxAttempts)await delay();
  }
  throw new Error('No verified dedicated Linux qualification completed within the bounded wait');
}
