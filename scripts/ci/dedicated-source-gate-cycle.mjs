// One reconciliation owns its API/deadline budget and reviewed-controller fence.
import {readReviewedConfiguration} from './dedicated-api.mjs';
const sha=/^[a-f0-9]{40}$/;
class DeferredReconciliation extends Error {}
export const isDeferredReconciliation=error=>error instanceof DeferredReconciliation;

export function maintenanceBatch(pulls,createdAt){
 const time=Date.parse(createdAt);
 if(!Number.isFinite(time))throw new Error('Authenticated maintenance creation time is missing');
 const sorted=[...pulls].sort((a,b)=>a.number-b.number),count=Math.ceil(sorted.length/8);
 if(!count)return [];
 const slot=Math.floor(time/900000),index=slot%count;
 const selected=sorted.slice(index*8,index*8+8),rotation=Math.floor(slot/count)%selected.length;
 return [...selected.slice(rotation),...selected.slice(0,rotation)];
}

export function reconciliationCycle(source,issuer,repo,controller,options){
 const bounded=!options.prNumber&&!options.childrenOf,limits=options.maintenanceLimits??{};
 const calls=limits.maxApiCalls??256,milliseconds=limits.maxMilliseconds??240000;
 if(!Number.isSafeInteger(calls)||calls<1||calls>256||!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>240000)throw new Error('Invalid maintenance limits');
 const deadline=bounded?Date.now()+milliseconds:Infinity;
 const aborter=new AbortController();let used=0,reserved=0,stopped;
 const stop=(reason,kind='budget')=>{if(!stopped){stopped=new DeferredReconciliation(reason);stopped.kind=kind;}throw stopped;};
 const assertAvailable=()=>{
  if(stopped)throw stopped;
  if(bounded&&(Date.now()>=deadline||used+reserved>=calls||aborter.signal.aborted))stop('Maintenance deferred at its reviewed budget');
 };
 const timer=bounded?setTimeout(()=>aborter.abort(),milliseconds):undefined;timer?.unref?.();
 const invoke=async(target,method,args={},admitted=false)=>{
  if(!admitted)assertAvailable();used++;
  const remaining=bounded?Math.max(1,Math.floor(deadline-Date.now())):10000;
  if(admitted&&bounded&&Date.now()>=deadline)aborter.abort();
  const request={...args.request,timeout:Math.min(args.request?.timeout??10000,remaining),
   ...(bounded?{signal:args.request?.signal?AbortSignal.any([args.request.signal,aborter.signal]):aborter.signal}:{})};
  try{return await method.call(target,{...args,request});}
  catch(error){if(!admitted&&(stopped||bounded&&(Date.now()>=deadline||aborter.signal.aborted)))stop('Maintenance deferred at its reviewed deadline');throw error;}
 };
 const wrap=client=>({...client,rest:Object.fromEntries(Object.entries(client.rest).map(([namespace,methods])=>[namespace,new Proxy(methods,{get(target,key){
  const method=target[key];return typeof method==='function'?(args={})=>invoke(target,method,args):method;
 }})]))});
 const github=wrap(source),gateGithub=wrap(issuer);
 const generation=async values=>{
  assertAvailable();
  const pin=values.MATRIX_CI_CONTROLLER_SHA;
  const valid=sha.test(pin||'')&&/^sha256:[a-f0-9]{64}$/.test(values.MATRIX_CI_RUNNER_IMAGE_DIGEST||'')&&/^[a-f0-9]{64}$/.test(values.MATRIX_CI_RUNNER_HARNESS_DIGEST||'');
  if(!valid)return false;
  if(pin===controller.sha)return true;
  const {data:main}=await github.rest.repos.getBranch({...repo,branch:'main'});
  if(main.name!=='main'||!sha.test(main.commit?.sha||''))throw new Error('Invalid replacement main identity');
  const {data:onMain}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${pin}...${main.commit.sha}`});
  const {data:advance}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${controller.sha}...${pin}`});
  if(['ahead','identical'].includes(onMain.status)&&onMain.merge_base_commit?.sha===pin&&advance.status==='ahead'&&advance.merge_base_commit?.sha===controller.sha)stop('Reconciliation superseded by a reviewed newer main controller','superseded');
  return false;
 };
 const missingHostedConfiguration=values=>{
  const fields=[['MATRIX_CI_CONTROLLER_SHA',sha],['MATRIX_CI_RUNNER_IMAGE_DIGEST',/^sha256:[a-f0-9]{64}$/],['MATRIX_CI_RUNNER_HARNESS_DIGEST',/^[a-f0-9]{64}$/]];
  const absent=value=>value===undefined||value==='';
  return values.MATRIX_CI_DEDICATED_ENABLED!=='true'&&values.MATRIX_CI_DEDICATED_SHADOW!=='true'&&
   fields.some(([key])=>absent(values[key]))&&fields.every(([key,pattern])=>absent(values[key])||pattern.test(values[key]))&&
   (absent(values.MATRIX_CI_CONTROLLER_SHA)||values.MATRIX_CI_CONTROLLER_SHA===controller.sha);
 };
 return {github,gateGithub,assertAvailable,isStopped:()=>Boolean(stopped),
  metrics:()=>({apiCalls:used,budgetDeferred:stopped?.kind==='budget',superseded:stopped?.kind==='superseded',maxApiCalls:bounded?calls:null}),
  initial:async values=>generation(values),
  beforeWrite:async(conclusion,notApplicable=false,hostedRecovery=false)=>{
   const values=await readReviewedConfiguration(github,repo),valid=await generation(values);
   if(!valid&&conclusion!=='failure'&&!notApplicable&&!(hostedRecovery&&missingHostedConfiguration(values)))throw new Error('Reviewed execution configuration changed before qualification');
  },
  beforeDispatch:async(hostedRecovery=false)=>{
   const values=await readReviewedConfiguration(github,repo);
   if(!await generation(values)&&!(hostedRecovery&&missingHostedConfiguration(values)))throw new Error('Reviewed execution configuration changed before dispatch');
  },
  dispatchAfterMarker:async(hostedRecovery,marker,args,onDispatchAttempt)=>{
   const values=await readReviewedConfiguration(github,repo);
   if(!await generation(values)&&!(hostedRecovery&&missingHostedConfiguration(values)))throw new Error('Reviewed execution configuration changed before dispatch');
   assertAvailable();
   // Keep the final request slot unavailable to the marker's configuration read/write.
   if(bounded&&used+reserved+3>calls)stop('Maintenance deferred before requester dispatch admission');
   reserved++;let unused=true;
   try{
    await marker();
    reserved--;unused=false;
    // From this point the provider method is attempted, even if its signal is already
    // aborted. Its outcome is ambiguous; never turn it into a local pre-call deferral.
    onDispatchAttempt?.();
    return await invoke(source.rest.actions,source.rest.actions.createWorkflowDispatch,args,true);
   }finally{if(unused)reserved--;}
  },close:()=>clearTimeout(timer)};
}
