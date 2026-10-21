// Read-only backend handoff; only authenticated cleanup-proved infrastructure selects hosted recovery.
import {resolveMainSource} from './dedicated-main.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {assertMainPrIdentity,resolveMainPrSnapshot} from './dedicated-main-pr.mjs';
export async function requestingSnapshot(github,context,refresh){
 if(refresh)return refresh;
 if(context.eventName==='push'&&context.ref==='refs/heads/main')return resolveMainSource(github,context.repo,context.sha);
 const pull=context.payload?.pull_request;
 if(!pull)throw new Error('Unsupported dedicated requesting source');
 const snapshot={sourceSha:context.sha,headSha:pull.head.sha,headRef:pull.head.ref,baseSha:pull.base.sha,baseRef:pull.base.ref,prNumber:pull.number};
 if(snapshot.baseRef==='main'){
  const {data:live}=await github.rest.pulls.get({...context.repo,pull_number:pull.number,request:{timeout:10_000,signal:AbortSignal.timeout(10_000)}});
  assertMainPrIdentity(context.repo,live,snapshot);
  return resolveMainPrSnapshot(github,context.repo,live,{sourceSha:context.sha});
 }
 return snapshot;
}
// Main is Linux-first: anything short of a verified Linux pass inside these bounds runs full hosted CI instead.
export const MAIN_LINUX_ADMISSION_ATTEMPTS=10;
const hostedFallback=error=>({provider:'hosted',infrastructureFallback:true,controllerRunId:0,fallbackReason:error.message});
// Main can move before this step starts; a commit that is no longer main still gets full hosted CI.
export async function decideRequestingBackend(github,context,refresh,requesting,options={}){
 const main=!refresh&&context.eventName==='push'&&context.ref==='refs/heads/main';
 let snapshot;
 try{snapshot=await requestingSnapshot(github,context,refresh);}
 catch(error){if(!main||!(error instanceof Error))throw error;return hostedFallback(error);}
 return decideCiBackend(github,{...context.repo,...snapshot,...requesting},options);
}
export const MAIN_LINUX_BUDGET_MS=25*60_000;
export async function decideCiBackend(github,expected,options={}){
 const main=expected.sourceKind==='main';
 let result;
 try{result=await waitForDedicatedResult(github,expected,{...options,allowInfrastructureFallback:true,...(main?{admissionAttempts:MAIN_LINUX_ADMISSION_ATTEMPTS,maxMilliseconds:MAIN_LINUX_BUDGET_MS}:{})});}
 catch(error){
  if(!main||!(error instanceof Error))throw error;
  return hostedFallback(error);
 }
 return result.infrastructure?{provider:'hosted',infrastructureFallback:true,controllerRunId:result.runId}:{provider:'linux',infrastructureFallback:false,controllerRunId:result.runId};
}
