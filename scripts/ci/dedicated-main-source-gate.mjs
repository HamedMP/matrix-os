// Independently qualify the exact current main push through the checks-only App.
// Never dispatch a replacement push or modify the Actions-owned CI aggregate.
import {readCurrentBranchSha} from './dedicated-branch.mjs';
import {resolveMainSource,verifyMainSource} from './dedicated-main.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {verifyFullHostedCoverage} from './dedicated-hosted.mjs';
import {verifyMainCiDecision,authenticatedMainDecisionProof} from './main-ci-decision.mjs';
import {resolveReusablePrCoverage,mainLinuxFailed} from './main-ci-reuse.mjs';
const request={timeout:10000};
// Reuse is re-derived with the exact gate App id against the exact proof the receipt named,
// under the configuration main decided with; a Linux failure on this main commit always wins.
async function verifyFreshReuse(github,repo,snapshot,decision,options){
 const from=decision.reusedFrom;
 const again=await resolveReusablePrCoverage(github,repo,snapshot.sourceSha,{gateAppId:options.gateAppId,checkId:from.qualificationCheckId,
  qualification:{controllerSha:from.controllerSha,imageDigest:from.imageDigest,harnessDigest:from.harnessDigest},
  frontier:{coverageBaseSha:decision.coverageBaseSha,bootstrap:decision.bootstrap}});
 if(!again.reused||JSON.stringify(again.reusedFrom)!==JSON.stringify(from))throw new Error(`Reused PR coverage did not re-verify: ${again.reason??'proof changed'}`);
}
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
  const summary=JSON.stringify({...evidence,...extra});if(Buffer.byteLength(summary)>4096)throw new Error('Main qualification App summary exceeds bound');
  const args={...repo,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`,status:'completed',conclusion,request,output:{title,summary}};
  const {data:written}=prior?await options.gateGithub.rest.checks.update({...args,check_run_id:prior.check.id}):await options.gateGithub.rest.checks.create({...args,name:'CI Source Qualification',head_sha:source});
  if(written.app?.id!==options.gateAppId||written.app?.slug==='github-actions'||written.name!=='CI Source Qualification'||written.head_sha!==source)throw new Error('Dedicated main gate App issuer response mismatch');
 };
 if(config.controllerSha!==controller.sha||!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest||'')||!/^[a-f0-9]{64}$/.test(config.harnessDigest||'')){
  await write('failure','Reviewed main execution configuration is incomplete');return 1;
 }
 try{
  snapshot=await resolveMainSource(github,repo,source);Object.assign(evidence,snapshot);
  if(!authenticatedMainDecisionProof(prior,repo,oldRun,snapshot,controller,config,mode))delete evidence.coverageProof;
  const requester=await currentRequester(github,repo,snapshot);
  if(!requester||!authenticatedMainDecisionProof(prior,repo,requester,snapshot,controller,config,mode))delete evidence.coverageProof;
  if(!requester||requester.status!=='completed'){
   // Running or not-yet-visible CI is not a failure; the completed-CI reconcile settles this check.
   await write('neutral','Waiting for exact-main CI to finish',requester?{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,waitingForRequester:true}:{waitingForRequester:true});return 1;
  }
  if(requester.conclusion!=='success'){
   await write('failure','Current exact-main requesting CI failed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});return 1;
  }
  const decision=await verifyMainCiDecision(github,repo,requester,{prior,snapshot,controller,config,mode});
  let result;
  // Reused coverage is re-derived here with the exact gate App id; any difference fails closed.
  if(decision.reusedFrom){
   // A reuse this gate already verified for the same requester stays settled: live run
   // history only grows, and re-deriving it would turn a tested main red with nothing to
   // fall back on. The prior check is this App's own authenticated output.
   const settled=prior?.check.status==='completed'&&prior.check.conclusion==='success'&&prior.evidence.sourceSha===snapshot.sourceSha&&prior.evidence.requestingRunId===requester.id&&prior.evidence.requestingRunAttempt===requester.run_attempt&&JSON.stringify(prior.evidence.reusedFrom)===JSON.stringify(decision.reusedFrom);
   if(!settled)await verifyFreshReuse(github,repo,snapshot,decision,options);
   else{
    // A Linux run that finishes failed after settling still wins; an API error alone never
    // flips settled, tested coverage to red.
    let failed=false;
    try{failed=await mainLinuxFailed(github,repo,snapshot.sourceSha);}
    catch(error){if(!(error instanceof Error))throw error;console.warn(`Main source qualification kept settled reuse: ${String(error.message).split('\n')[0].slice(0,300)}`);}
    if(failed)throw new Error('Linux qualification failed on this main commit');
   }
   result={reusedFrom:decision.reusedFrom};
  }
  else try{result=decision.shouldRun?await waitForDedicatedResult(github,{...repo,...snapshot,requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...config,mode,serverUrl:'https://github.com'},{maxAttempts:1,allowInfrastructureFallback:true}):{docsOnly:true};}
  catch(error){
   if(!(error instanceof Error))throw error;
   // Delegated main runs full hosted CI whenever Linux does not verify; that hosted coverage qualifies main.
   if(mode==='delegated')result={linuxFallback:true};
   else if(mode!=='shadow')throw error;
  }
  if(!result){
   // Shadow mode observes Linux qualification; once hosted CI passed, missing evidence must not block main.
   await verifyMainSource(github,repo,snapshot);
   const latest=await currentRequester(github,repo,snapshot);
   if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('New main requesting attempt superseded coverage');
   // Keep the verified hosted decision so an expired decision artifact cannot flip unchanged main to failure.
   Object.assign(evidence,{coverageProof:decision.coverageProof});
   await write('neutral','Shadow Linux qualification not verified; hosted CI passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,shadowUnverified:true});
   return 1;
  }
  if(result.docsOnly)Object.assign(evidence,{docsOnly:true,selectedHostedLaneCount:decision.selectedHostedLaneCount});
  if(result.infrastructure||result.linuxFallback){
   const coverage=await verifyFullHostedCoverage(github,repo,requester);
   Object.assign(evidence,result.infrastructure?{infrastructureFallback:true,infrastructure:result.infrastructure,...coverage}:{linuxFallback:true,...coverage});
  }
  await verifyMainSource(github,repo,snapshot);
  const latest=await currentRequester(github,repo,snapshot);
  if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('New main requesting attempt superseded coverage');
  Object.assign(evidence,{coverageProof:decision.coverageProof});
  if(result.reusedFrom)Object.assign(evidence,{reusedFrom:result.reusedFrom});
  await write('success',result.reusedFrom?'Current exact-main reused PR qualification passed':result.docsOnly?'Current exact-main selected documentation coverage passed':result.infrastructure?'Current exact-main full hosted infrastructure recovery passed':result.linuxFallback?'Current exact-main full hosted fallback coverage passed':'Current exact-main Linux qualification passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});
 }catch(error){
  if(!(error instanceof Error))throw error;
  // The check title stays generic; the controller log keeps the reason for operators.
  console.warn(`Main source qualification failed: ${String(error.message).split('\n')[0].slice(0,300)}`);
  await write('failure','Fresh exact-main qualification evidence is missing or stale');
 }
 return 1;
}
