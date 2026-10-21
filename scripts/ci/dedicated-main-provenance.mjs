import {isolatedRunPin,verifyRunExecution} from './dedicated-isolated.mjs';
// Public issuer identity pinned by reviewed code. The private signing key stays
// in the existing main-only matrix-ci environment; candidate data cannot select
// another App as an authority for historical merge provenance.
export const MAIN_SOURCE_APP_ID=5271502;
export const MAIN_SOURCE_BINDING_LIMIT=4;
const request={timeout:10_000};
const sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function recordedMainSources(evidence,snapshot){
 if(evidence?.schemaVersion!==1||evidence.prNumber!==snapshot.prNumber||evidence.headSha!==snapshot.headSha||evidence.headRef!==snapshot.headRef||evidence.baseRef!=='main'||!Array.isArray(evidence.sourceBindings)||evidence.sourceBindings.length>MAIN_SOURCE_BINDING_LIMIT)return [];
 return evidence.sourceBindings.filter(value=>sha.test(value?.baseSha||'')&&sha.test(value?.sourceSha||'')).map(({baseSha,sourceSha})=>({baseSha,sourceSha}));
}
// A later rerun does not erase a protected observation made by an earlier
// authenticated controller attempt. This reads identity only, not receipt credit.
export async function recordedControllerAttempt(github,repo,runId,attempt){
 const {data:latest}=await github.rest.actions.getWorkflowRun({...repo,run_id:runId,request});
 if(latest.id===runId&&id(latest.run_attempt)&&latest.run_attempt>attempt){
  const {data:recorded}=await github.rest.actions.getWorkflowRunAttempt({...repo,run_id:runId,attempt_number:attempt,request});
  return recorded;
 }
 return latest;
}
export async function hasMainSourceProvenance(github,repo,snapshot){
 const prefix=`https://github.com/${repo.owner}/${repo.repo}/actions/runs/`,fullName=`${repo.owner}/${repo.repo}`;
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci-dedicated.yml')throw new Error('Unexpected provenance controller workflow');
 for(let page=1;page<=3;page++){
  const {data}=await github.rest.checks.listForRef({...repo,ref:snapshot.headSha,check_name:'CI Source Qualification',app_id:MAIN_SOURCE_APP_ID,filter:'latest',per_page:100,page,request});
  if(!Array.isArray(data.check_runs)||data.check_runs.length>100)throw new Error('Invalid bounded main source provenance history');
  for(const check of data.check_runs){
   if(check.name!=='CI Source Qualification'||check.app?.id!==MAIN_SOURCE_APP_ID||check.app?.slug==='github-actions'||check.head_sha!==snapshot.headSha||!check.details_url?.startsWith(prefix)||typeof check.output?.summary!=='string'||check.output.summary.length>4096)continue;
   let evidence;try{evidence=JSON.parse(check.output.summary);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
   if(!recordedMainSources(evidence,snapshot).some(value=>value.baseSha===snapshot.baseSha&&value.sourceSha===snapshot.sourceSha))continue;
   const runId=Number(check.details_url.slice(prefix.length));
   if(!id(runId)||evidence.controllerRef!=='refs/heads/main'||!sha.test(evidence.controllerSha||'')||!id(evidence.controllerAttempt))continue;
   const run=await recordedControllerAttempt(github,repo,runId,evidence.controllerAttempt);
   if(run.id!==runId||run.run_attempt!==evidence.controllerAttempt||run.workflow_id!==workflow.id||run.path!==workflow.path||!same(run.repository?.full_name,fullName)||!same(run.head_repository?.full_name,fullName))continue;
   if(['push','schedule'].includes(run.event)&&run.head_branch==='main'&&sha.test(run.head_sha||''))return true;
   if(run.event==='pull_request_target'&&run.head_sha===snapshot.headSha&&run.head_branch===snapshot.headRef)return true;
   if(run.event==='workflow_run'&&((run.head_branch==='main'&&sha.test(run.head_sha||''))||(run.head_sha===snapshot.headSha&&run.head_branch===snapshot.headRef)))return true;
   if(run.event==='workflow_dispatch'&&isolatedRunPin(run)){
    const origin=await verifyRunExecution(github,repo,run,'.github/workflows/ci-dedicated.yml',evidence.controllerSha);
    if(JSON.stringify(origin)===JSON.stringify(evidence.executionOrigin))return true;
   }
  }
  if(data.check_runs.length<100)return false;
 }
 throw new Error('Main source provenance history exceeds bounded coverage');
}

// Called in the existing benchmark pre-dispatch step, before the short SSH
// grant deadline begins. The parallel reconcile job may still be publishing
// the trusted event journal; its absence never authorizes a historical source.
export async function waitForMainSourceProvenance(github,repo,snapshot,options={}){
 const aborter=new AbortController();
 let rejectDeadline;
 const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
 const timer=setTimeout(()=>{const error=new Error('Protected main source provenance was not published before dispatch');aborter.abort(error);rejectDeadline(error);},60_000);
 timer.unref?.();
 const client={...github,rest:{...github.rest,actions:new Proxy(github.rest.actions,{get(target,name){const fn=target[name];return typeof fn==='function'?args=>fn.call(target,{...args,request:{...args.request,signal:aborter.signal}}):fn;}}),checks:new Proxy(github.rest.checks,{get(target,name){const fn=target[name];return typeof fn==='function'?args=>fn.call(target,{...args,request:{...args.request,signal:aborter.signal}}):fn;}})}};
 const poll=async()=>{
  for(let attempt=0;attempt<12;attempt++){
   aborter.signal.throwIfAborted();
   await options.assertCurrent?.();
   if(await hasMainSourceProvenance(client,repo,snapshot))return;
   if(attempt<11)await(options.delay??(()=>new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(pause);reject(aborter.signal.reason);};const pause=setTimeout(()=>{aborter.signal.removeEventListener('abort',stop);resolve();},5000);aborter.signal.addEventListener('abort',stop,{once:true});})))();
  }
  throw new Error('Protected main source provenance was not published before dispatch');
 };
 try{return await Promise.race([poll(),deadline]);}
 finally{clearTimeout(timer);aborter.abort();}
}
