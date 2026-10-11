// Independently qualify the exact current main push through the checks-only App.
// Never dispatch a replacement push or modify the Actions-owned CI aggregate.
import {resolveMainSource,verifyMainSource} from './dedicated-main.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {verifyFullHostedCoverage} from './dedicated-hosted.mjs';
const request={timeout:10000},sha=/^[a-f0-9]{40}$/;
export async function reconcileMainSourceQualification(github,repo,controller,options,config,workflow,{ownedGate,currentRequester}){
 const {data:ref}=await github.rest.git.getRef({...repo,ref:'heads/main',request});
 const source=ref?.object?.sha;if(!sha.test(source||''))throw new Error('Invalid main source gate ref');
 const pull={number:0,head:{sha:source,ref:'main'}};
 const {prior,history}=await ownedGate(github,repo,pull,workflow,options.gateAppId);
 if(!config.admitted&&!history&&!prior)return 0;
 let snapshot={sourceKind:'main',prNumber:0,sourceSha:source,headSha:source,headRef:'main',baseRef:'main'};
 const mode=!config.admitted&&['delegated','shadow'].includes(prior?.evidence.qualificationMode)?prior.evidence.qualificationMode:config.mode;
 const evidence={schemaVersion:1,admittedPreviously:true,...snapshot,qualificationMode:mode,controllerSha:controller.sha,controllerRef:controller.ref,controllerAttempt:options.runAttempt};
 const write=async(conclusion,title,extra={})=>{
  const args={...repo,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`,status:'completed',conclusion,request,output:{title,summary:JSON.stringify({...evidence,...extra})}};
  const {data:written}=prior?await options.gateGithub.rest.checks.update({...args,check_run_id:prior.check.id}):await options.gateGithub.rest.checks.create({...args,name:'CI Source Qualification',head_sha:source});
  if(written.app?.id!==options.gateAppId||written.app?.slug==='github-actions'||written.name!=='CI Source Qualification'||written.head_sha!==source)throw new Error('Dedicated main gate App issuer response mismatch');
 };
 if(config.controllerSha!==controller.sha||!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest||'')||!/^[a-f0-9]{64}$/.test(config.harnessDigest||'')){
  await write('failure','Reviewed main execution configuration is incomplete');return 1;
 }
 try{
  snapshot=await resolveMainSource(github,repo,source);Object.assign(evidence,snapshot);
  const requester=await currentRequester(github,repo,snapshot);
  if(!requester||requester.status!=='completed'||requester.conclusion!=='success'){
   await write('failure','Current exact-main requesting CI is pending or failed',requester?{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt}:{});return 1;
  }
  const result=await waitForDedicatedResult(github,{...repo,...snapshot,requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...config,mode,serverUrl:'https://github.com'},{maxAttempts:1,allowInfrastructureFallback:true});
  if(result.infrastructure){
   const coverage=await verifyFullHostedCoverage(github,repo,requester);
   Object.assign(evidence,{infrastructureFallback:true,infrastructure:result.infrastructure,...coverage});
  }
  await verifyMainSource(github,repo,snapshot);
  const latest=await currentRequester(github,repo,snapshot);
  if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.status!=='completed'||latest.conclusion!=='success')throw new Error('New main requesting attempt superseded coverage');
  await write('success',result.infrastructure?'Current exact-main full hosted infrastructure recovery passed':'Current exact-main Linux qualification passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});
 }catch(error){
  if(!(error instanceof Error))throw error;
  await write('failure','Fresh exact-main qualification evidence is missing or stale');
 }
 return 1;
}
