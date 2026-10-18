// Independently qualify the exact current main push through the checks-only App.
// Never dispatch a replacement push or modify the Actions-owned CI aggregate.
import {readCurrentBranchSha} from './dedicated-branch.mjs';
import {resolveMainSource,verifyMainSource} from './dedicated-main.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {verifyFullHostedCoverage} from './dedicated-hosted.mjs';
import {verifyMainCiDecision,authenticatedMainDecisionProof} from './main-ci-decision.mjs';
import {logGateEvent} from './gate-log.mjs';
import {isDeferredReconciliation} from './dedicated-source-gate-cycle.mjs';
const request={timeout:10000};
export async function reconcileMainSourceQualification(github,repo,controller,options,config,workflow,{ownedGate,currentRequester}){
 const source=await readCurrentBranchSha(github,repo,'main',request);
 const pull={number:0,head:{sha:source,ref:'main'}};
 const {prior,history}=await ownedGate(github,repo,pull,workflow,options.gateAppId);
 if(!config.admitted&&!history&&!prior)return 0;
 let snapshot={sourceKind:'main',prNumber:0,sourceSha:source,headSha:source,headRef:'main',baseRef:'main'};
 const mode=!config.admitted&&['delegated','shadow'].includes(prior?.evidence.qualificationMode)?prior.evidence.qualificationMode:config.mode;
 const evidence={schemaVersion:1,admittedPreviously:true,...snapshot,qualificationMode:mode,controllerSha:controller.sha,controllerRef:controller.ref,controllerAttempt:options.runAttempt};
 const oldRun={id:prior?.evidence.requestingRunId,run_attempt:prior?.evidence.requestingRunAttempt,head_sha:source};
 const retained=authenticatedMainDecisionProof(prior,repo,oldRun,{...prior?.evidence,...snapshot},controller,config,mode);
 if(retained)Object.assign(evidence,retained.source,{coverageProof:retained,requestingRunId:oldRun.id,requestingRunAttempt:oldRun.run_attempt});
 const write=async(conclusion,title,extra={})=>{
  await options.cycle?.beforeWrite(conclusion);
  const summary=JSON.stringify({...evidence,...extra});if(Buffer.byteLength(summary)>4096)throw new Error('Main qualification App summary exceeds bound');
  const args={...repo,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`,...(conclusion?{status:'completed',conclusion}:{status:'in_progress'}),request,output:{title,summary}};
  const update=prior&&(conclusion||prior.check.status==='in_progress');
  const {data:written}=update?await options.gateGithub.rest.checks.update({...args,check_run_id:prior.check.id}):await options.gateGithub.rest.checks.create({...args,name:'CI Source Qualification',head_sha:source});
  if(written.app?.id!==options.gateAppId||written.app?.slug==='github-actions'||written.name!=='CI Source Qualification'||written.head_sha!==source)throw new Error('Dedicated main gate App issuer response mismatch');
 };
 if(config.controllerSha!==controller.sha||!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest||'')||!/^[a-f0-9]{64}$/.test(config.harnessDigest||'')){
  await write('failure','Reviewed main execution configuration is incomplete');return 1;
 }
 // Names the phase that failed in the controller log; the check title stays generic.
 let stage='source';
 try{
  snapshot=await resolveMainSource(github,repo,source);Object.assign(evidence,snapshot);
  if(!authenticatedMainDecisionProof(prior,repo,oldRun,snapshot,controller,config,mode))delete evidence.coverageProof;
  stage='requester';
  const requester=await currentRequester(github,repo,snapshot);
  if(!requester||!authenticatedMainDecisionProof(prior,repo,requester,snapshot,controller,config,mode))delete evidence.coverageProof;
  if(!requester||requester.status!=='completed'){
   // Running or not-yet-visible CI is not a failure; the completed-CI reconcile settles this check.
   stage='write';
   await write(null,'Waiting for exact-main CI to finish',requester?{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,waitingForRequester:true}:{waitingForRequester:true});return 1;
  }
  if(requester.conclusion!=='success'){
   stage='write';
   await write('failure','Current exact-main requesting CI failed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});return 1;
  }
  stage='decision';
  const decision=await verifyMainCiDecision(github,repo,requester,{prior,snapshot,controller,config,mode});
  stage='linux';
  let result;
  try{result=decision.shouldRun?await waitForDedicatedResult(github,{...repo,...snapshot,requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...config,mode,serverUrl:'https://github.com'},{maxAttempts:1,allowInfrastructureFallback:true}):{docsOnly:true};}
  catch(error){if(isDeferredReconciliation(error))throw error;
   if(!(error instanceof Error))throw error;
   // Delegated main runs full hosted CI whenever Linux does not verify; that hosted coverage qualifies main.
   if(mode!=='delegated'&&mode!=='shadow')throw error;
   logGateEvent('Main source qualification fell back','linux',error);
   if(mode==='delegated')result={linuxFallback:true};
  }
  if(!result){
   // Shadow mode observes Linux qualification; once hosted CI passed, missing evidence must not block main.
   stage='shadow-supersede';
   await verifyMainSource(github,repo,snapshot);
   const latest=await currentRequester(github,repo,snapshot);
   if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('New main requesting attempt superseded coverage');
   // Keep the verified hosted decision so an expired decision artifact cannot flip unchanged main to failure.
   Object.assign(evidence,{coverageProof:decision.coverageProof});
   stage='write';
   await write('neutral','Shadow Linux qualification not verified; hosted CI passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,shadowUnverified:true});
   return 1;
  }
  if(result.docsOnly)Object.assign(evidence,{docsOnly:true,selectedHostedLaneCount:decision.selectedHostedLaneCount});
  if(result.infrastructure||result.linuxFallback){
   stage='hosted-coverage';
   const coverage=await verifyFullHostedCoverage(github,repo,requester);
   Object.assign(evidence,result.infrastructure?{infrastructureFallback:true,infrastructure:result.infrastructure,...coverage}:{linuxFallback:true,...coverage});
  }
  stage='supersede';
  await verifyMainSource(github,repo,snapshot);
  const latest=await currentRequester(github,repo,snapshot);
  if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('New main requesting attempt superseded coverage');
  Object.assign(evidence,{coverageProof:decision.coverageProof});
  stage='write';
  await write('success',result.docsOnly?'Current exact-main selected documentation coverage passed':result.infrastructure?'Current exact-main full hosted infrastructure recovery passed':result.linuxFallback?'Current exact-main full hosted fallback coverage passed':'Current exact-main Linux qualification passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});
 }catch(error){if(isDeferredReconciliation(error))throw error;
  if(!(error instanceof Error))throw error;
  logGateEvent('Main source qualification failed',stage,error);
  await write('failure','Fresh exact-main qualification evidence is missing or stale');
 }
 return 1;
}
