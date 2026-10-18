import {isolatedRunPin,verifyRunExecution} from './dedicated-isolated.mjs';
// Read-only GitHub API evidence verification. Never execute controller artifacts.
import {downloadControllerReceipt} from './dedicated-artifact.mjs';
import {verifyControllerArtifact} from './dedicated-artifact-proof.mjs';
import {validInfrastructureProof} from './dedicated-outcome.mjs';
import {verifyCurrentDedicatedSource} from './dedicated-admission.mjs';
import {authenticatedControllerRun} from './dedicated-refresh.mjs';
import {createConditionalGithub} from './dedicated-api.mjs';
import {newestWorkflowRun} from './dedicated-history.mjs';
import {mainPrRequest} from './dedicated-main-pr.mjs';
const workflowPath = '.github/workflows/ci-dedicated.yml';
const trustedRunPath = value => [workflowPath, `${workflowPath}@main`, `${workflowPath}@refs/heads/main`].includes(value);
const shaPattern = /^[a-f0-9]{40}$/;
const request = {timeout: 10_000};
const sameRepo = (value, expected) => typeof value === 'string' && value.toLowerCase() === `${expected.owner}/${expected.repo}`.toLowerCase();
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function parseEvidence(check, expected, latest) {
  if (!positiveId(check.id) || check.name !== 'Dedicated CI Results' || check.head_sha !== expected.headSha ||
      check.app?.slug !== 'github-actions' || !['queued','in_progress','completed'].includes(check.status)) return null;
  const summary = check.output?.summary;
  if (typeof summary !== 'string' || summary.length > 4096) return null;
  let evidence;
  try { evidence = JSON.parse(summary); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const repositoryUrl = `${expected.serverUrl}/${expected.owner}/${expected.repo}`;
  let runId;
  if (check.details_url === `${repositoryUrl}/runs/${check.id}`) {
    // Actions can place manually created checks in a different suite from the
    // creating workflow. Its explicit run ID is only an index: independently
    // authenticate that exact controller/attempt, then require its immutable
    // artifact before awarding any coverage. Legacy indexes retain suite proof.
    if (!positiveId(latest?.id)) return null;
    if (evidence?.controllerRunId !== undefined) {
      if (!positiveId(evidence.controllerRunId) || evidence.controllerRunId !== latest.id) return null;
    } else if (!positiveId(check.check_suite?.id) || check.check_suite.id !== latest.check_suite_id) return null;
    runId = latest.id;
  } else {
    const prefix = `${repositoryUrl}/actions/runs/`;
    if (typeof check.details_url !== 'string' || !check.details_url.startsWith(prefix)) return null;
    const id = check.details_url.slice(prefix.length);
    if (!/^[1-9][0-9]{0,15}$/.test(id) || !positiveId(Number(id))) return null;
    runId = Number(id);
  }
  if (evidence?.controllerRunId !== undefined &&
      (!positiveId(evidence.controllerRunId) || evidence.controllerRunId !== runId)) return null;
  if (!evidence || ![3,4].includes(evidence.schemaVersion) || evidence.suite !== 'qualification' ||
      evidence.sourceSha !== expected.sourceSha || evidence.headSha !== expected.headSha ||
      evidence.baseSha !== expected.baseSha || evidence.baseRef !== expected.baseRef ||
      evidence.sourceKind !== expected.sourceKind || (expected.sourceKind==='main'&&JSON.stringify(evidence.mergeParents)!==JSON.stringify(expected.mergeParents)) || evidence.prNumber !== expected.prNumber || !positiveId(evidence.controllerAttempt) ||
      !shaPattern.test(evidence.controllerSha || '') || evidence.controllerRef !== 'refs/heads/main' ||
      evidence.controllerWorkflow !== workflowPath || evidence.requestingRunId!==expected.requestingRunId ||
      evidence.requestingRunAttempt!==expected.requestingRunAttempt || evidence.imageDigest!==expected.imageDigest ||
      evidence.harnessDigest!==expected.harnessDigest || evidence.mode!==expected.mode ||
      (check.status==='completed'&&((evidence.receiptVerified!==true&&!validInfrastructureProof(evidence)) || !/^[a-f0-9]{64}$/.test(evidence.requestDigest||'') || !/^[a-f0-9]{32}$/.test(evidence.leaseId||'')))) return null;
  return {...evidence, runId};
}

const requestMarker = expected => `dedicated-ci-v2 pr=${expected.prNumber} head=${expected.headSha} base=${expected.baseSha} requested=true`;
// REST run head_* fields describe the PR candidate, not the executable workflow
// definition. Default origin is enforced by GitHub's pull_request_target contract,
// the registered workflow ID/path and the controller's main ref/workflow_ref guard.
// Never compare candidate head_sha to the controller SHA reported by its check.
function trustedController(run, expected, workflow) {
  return positiveId(run.run_attempt)&&authenticatedControllerRun(run,{owner:expected.owner,repo:expected.repo},expected,workflow,expected.headRef);
}

async function newestRequest(github,repo,expected,workflow,beforeId){
 return newestWorkflowRun(github,repo,workflow,async run=>{
  if(!trustedController(run,expected,workflow)||beforeId&&run.id>=beforeId)return false;
  const pin=isolatedRunPin(run);
  if(pin){
   if(!expected.controllerHistoryPins?.includes(pin))return false;
   await verifyRunExecution(github,repo,run,workflowPath,pin);
  }
  return true;
 },{kind:'controller',sourceKind:expected.sourceKind,headSha:expected.headSha,headRef:expected.headRef,controllerShas:expected.controllerHistoryPins});
}

async function newestController(github, repo, expected, workflow, latest) {
  if(!latest)return undefined;
  // At most 300 checks per poll; authenticate only the newest current-attempt
  // check for the newest source request, then discard the scoped array.
  const candidates=[];
  for(let page=1;page<=3;page++) {
    const {data}=await github.rest.checks.listForRef({...repo,ref:expected.headSha,per_page:100,page,filter:'all',check_name:'Dedicated CI Results',request});
    const checks=data.check_runs ?? [];
    if(!Array.isArray(checks) || checks.length>100)throw new Error('Invalid bounded check list');
    for(const check of checks) {
      const evidence=parseEvidence(check,expected,latest);
      if(evidence?.runId===latest.id && evidence.controllerAttempt===latest.run_attempt)candidates.push({check,evidence});
    }
    if(candidates.length||checks.length<100)break;
    if(page===3)throw new Error('Source check history exceeds bounded coverage');
  }
  candidates.sort((a,b)=>b.check.id-a.check.id);
  const selected=candidates[0];
  if(!selected)return undefined;
  const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:latest.id,request});
  if(!trustedController(run,expected,workflow) || run.id!==latest.id ||
      run.run_attempt!==selected.evidence.controllerAttempt)return undefined;
  const origin=await verifyRunExecution(github,repo,run,workflowPath,selected.evidence.controllerSha);
  if(selected.evidence.schemaVersion===4){
   if(!origin||JSON.stringify(origin)!==JSON.stringify(selected.evidence.executionOrigin))throw new Error('Isolated controller execution proof mismatch');
  }else if(origin)throw new Error('Isolated execution cannot use legacy controller evidence');
  return {...selected,run};
}

async function newestResultController(github,repo,expected,workflow){
 let latest=await newestRequest(github,repo,expected,workflow);
 for(let skipped=0;latest;skipped++){
  if(latest.status==='completed'&&latest.conclusion!=='success')return{latest};
  const selected=await newestController(github,repo,expected,workflow,latest);
  if(selected||latest.status!=='completed')return{latest,selected};
  if(skipped>=9)throw new Error('Completed controller history without result exceeds bounded coverage');
  latest=await newestRequest(github,repo,expected,workflow,latest.id);
 }
 return{};
}

export async function waitForDedicatedResult(github,expected,options={}) {
  const maximum=options.maxMilliseconds??3_900_000;
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>3_900_000)throw new Error('Invalid waiter deadline');
  const started=performance.now(),remainingMilliseconds=()=>Math.max(0,maximum-(performance.now()-started));
  const aborter=new AbortController();let timer;
  try{return await Promise.race([waitWithinDeadline(github,expected,{...options,signal:aborter.signal,remainingMilliseconds}),new Promise((_,reject)=>{timer=setTimeout(()=>{aborter.abort();reject(new Error('No verified dedicated Linux qualification completed within the bounded wait'));},maximum);timer.unref?.();})]);}
  finally{clearTimeout(timer);aborter.abort();}
}
async function waitWithinDeadline(github, expected, options={}) {
  if(![expected.requestingRunId,expected.requestingRunAttempt].every(positiveId)||
      !/^sha256:[a-f0-9]{64}$/.test(expected.imageDigest||'')||!/^[a-f0-9]{64}$/.test(expected.harnessDigest||'')||!['shadow','delegated'].includes(expected.mode)||
      ![expected.headSha,expected.baseSha,expected.sourceSha].every(sha=>shaPattern.test(sha || '')) ||
      (!(expected.sourceKind==='main'&&expected.prNumber===0)&&!positiveId(expected.prNumber)) || typeof expected.baseRef!=='string' || !expected.baseRef ||
      typeof expected.headRef!=='string' || !expected.headRef) {
    throw new Error('Invalid dedicated qualification revision');
  }
  const api=createConditionalGithub(github,{authenticationContext:`requester-${expected.requestingRunId}-${expected.requestingRunAttempt}`,signal:options.signal,waiterBackoff:{remainingMilliseconds:options.remainingMilliseconds}});github=api.github;
  const maxAttempts=options.maxAttempts ?? 130;
  if(!Number.isSafeInteger(maxAttempts) || maxAttempts<1 || maxAttempts>130)throw new Error('Invalid wait bound');
  const delay=options.delay ?? (()=>new Promise(resolve=>setTimeout(resolve,30_000)));
  const repo={owner:expected.owner,repo:expected.repo};
  const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
  if(workflow.path!==workflowPath)throw new Error('Unexpected dedicated controller workflow');
  if(expected.controllerSha&&expected.isolated!==false&&expected.sourceKind!=='main'){
    const pins=[expected.controllerSha];
    const {data:history}=await github.rest.checks.listForRef({...repo,ref:expected.headSha,check_name:'Dedicated CI Results',filter:'all',per_page:100,page:1,request});
    if(!Array.isArray(history.check_runs)||history.check_runs.length>100)throw new Error('Invalid bounded controller origin history');
    for(const check of history.check_runs){
      if(check.app?.slug!=='github-actions'||check.head_sha!==expected.headSha||typeof check.output?.summary!=='string'||check.output.summary.length>4096)continue;
      let evidence;try{evidence=JSON.parse(check.output.summary);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
      if(evidence.schemaVersion===4&&evidence.sourceSha===expected.sourceSha&&evidence.headSha===expected.headSha&&evidence.baseSha===expected.baseSha&&evidence.prNumber===expected.prNumber&&evidence.requestingRunId===expected.requestingRunId&&evidence.requestingRunAttempt===expected.requestingRunAttempt&&shaPattern.test(evidence.controllerSha||'')&&!pins.includes(evidence.controllerSha))pins.push(evidence.controllerSha);
    }
    if(pins.length>4)throw new Error('Controller execution history exceeds bounded pin coverage');
    expected={...expected,controllerHistoryPins:pins};
  }
  let ciWorkflow;
  const verifyMainRequester=async source=>{
    if(expected.baseRef!=='main'||expected.sourceKind!==undefined)return;
    if(!ciWorkflow){
      ({data:ciWorkflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request}));
      if(!positiveId(ciWorkflow.id)||ciWorkflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected requesting CI definition');
    }
    const newest=await newestWorkflowRun(github,repo,ciWorkflow,async run=>{if(!mainPrRequest(run,repo,expected,ciWorkflow))return false;await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');return true;},{kind:'requester',headSha:expected.headSha,headRef:expected.headRef,controllerShas:expected.controllerHistoryPins});
    if(!newest||newest.id!==expected.requestingRunId||newest.run_attempt!==expected.requestingRunAttempt||(newest.status==='completed'&&newest.conclusion!=='success'))throw new Error('A newer or failed requesting CI attempt superseded coverage');
  };
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    const currentSource=await verifyCurrentDedicatedSource(github,repo,expected);
    await verifyMainRequester(currentSource);
    const {latest,selected}=await newestResultController(github,repo,expected,workflow);
    if(latest?.status==='completed' && latest.conclusion!=='success') {
      throw new Error('Verified dedicated Linux qualification failed');
    }
    if(!selected&&options.admissionAttempts&&attempt+1>=options.admissionAttempts)throw new Error('No Linux controller admitted within the admission window');
    if(selected?.run.status==='completed') {
      const {check,evidence,run}=selected;
      if(run.conclusion!=='success' || (check.status==='completed' && check.conclusion!=='success'&&!(check.conclusion==='neutral'&&validInfrastructureProof(evidence)))) {
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
            const receipt=await downloadControllerReceipt(github,repo,provenance);
            const infrastructure=verifyControllerArtifact(receipt,evidence,expected,run,currentSource.mergeParents,check);
            const {latest:current,selected:currentSelected}=await newestResultController(github,repo,expected,workflow);
            if(current?.status==='completed' && current.conclusion!=='success') {
              throw new Error('Verified dedicated Linux qualification failed');
            }
            // A retry may have been queued while artifacts/jobs were fetched.
            if(currentSelected?.run.id===run.id && current?.id===run.id && current.run_attempt===run.run_attempt &&
                current.head_sha===run.head_sha && current.status==='completed' && current.conclusion==='success') {
              await verifyMainRequester(await verifyCurrentDedicatedSource(github,repo,expected));
              options.metrics?.(api.metrics());
              if(infrastructure){if(options.allowInfrastructureFallback!==true)throw new Error('Linux infrastructure unavailable; hosted coverage required');return {runId:evidence.runId,sourceSha:expected.sourceSha,infrastructure};}
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
