// All-PR freshness context, owned exclusively by the default controller.
// CI Results remains the genuine Actions aggregate and is never modified here.
import {assertDefaultController,verifyCurrentDedicatedSource} from './dedicated-admission.mjs';
import {authenticatedRequestingRun} from './dedicated-refresh.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {readReviewedConfiguration} from './dedicated-api.mjs';
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const sha=/^[a-f0-9]{40}$/;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const name='CI Source Qualification',path='.github/workflows/ci-dedicated.yml';
async function boundedPages(load,key){
 const rows=[];
 for(let page=1;page<=3;page++){
  const {data}=await load(page),values=key?data[key]:data;
  if(!Array.isArray(values)||values.length>100)throw new Error('Invalid bounded source gate API list');
  rows.push(...values);if(values.length<100)return rows;
 }
 throw new Error('Source gate API history exceeds bounded coverage');
}
async function ownedGate(github,repo,pull,workflow){
 const checks=await boundedPages(page=>github.rest.checks.listForRef({...repo,ref:pull.head.sha,filter:'all',per_page:100,page,request}),'check_runs');
 for(const check of checks.filter(check=>check.name===name&&check.app?.slug==='github-actions'&&check.head_sha===pull.head.sha).sort((a,b)=>b.id-a.id)){
  const prefix=`https://github.com/${repo.owner}/${repo.repo}/actions/runs/`;
  if(!id(check.id)||!check.details_url?.startsWith(prefix)||typeof check.output?.summary!=='string'||check.output.summary.length>4096)continue;
  let evidence;try{evidence=JSON.parse(check.output.summary);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
  const runId=Number(check.details_url.slice(prefix.length));
  if(!id(runId)||evidence?.schemaVersion!==1||evidence.prNumber!==pull.number||evidence.controllerRef!=='refs/heads/main'||!sha.test(evidence.controllerSha||'')||!id(evidence.controllerAttempt))continue;
  const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:runId,request});
  if(run.id!==runId||run.run_attempt!==evidence.controllerAttempt||run.workflow_id!==workflow.id||run.path!==path||!['pull_request_target','workflow_run','schedule','push'].includes(run.event)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))continue;
  // Scheduled/main-push definitions must never inherit a candidate-branch
  // run's app identity. PTR metadata describes the live PR head separately.
  if(['push','schedule'].includes(run.event)&&(run.head_branch!=='main'||!sha.test(run.head_sha||'')))continue;
  if(run.event==='pull_request_target'&&(run.head_sha!==pull.head.sha||run.head_branch!==pull.head.ref))continue;
  if(run.event==='workflow_run'&&run.head_branch!=='main'&&(run.head_sha!==pull.head.sha||run.head_branch!==pull.head.ref))continue;
  return{check,evidence};
 }
}
async function currentRequester(github,repo,snapshot){
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected refresh CI definition');
 const runs=await boundedPages(page=>github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,per_page:100,page,request}),'workflow_runs');
 return runs.filter(run=>authenticatedRequestingRun(run,repo,snapshot,workflow)).sort((a,b)=>b.id-a.id||b.run_attempt-a.run_attempt)[0];
}
async function settings(github,repo){
 const values=await readReviewedConfiguration(github,repo);
 return{controllerSha:values.MATRIX_CI_CONTROLLER_SHA,admitted:values.MATRIX_CI_DEDICATED_ENABLED==='true'||values.MATRIX_CI_DEDICATED_SHADOW==='true',mode:values.MATRIX_CI_DEDICATED_ENABLED==='true'?'delegated':'shadow',imageDigest:values.MATRIX_CI_RUNNER_IMAGE_DIGEST,harnessDigest:values.MATRIX_CI_RUNNER_HARNESS_DIGEST};
}
export async function reconcileSourceQualification(github,repo,controller,options){
 assertDefaultController(repo,controller);
 if(!id(options.runId)||!id(options.runAttempt))throw new Error('Invalid source gate controller identity');
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
 if(!id(workflow.id)||workflow.path!==path)throw new Error('Unexpected source gate workflow');
 const config=await settings(github,repo);
 const pulls=options.prNumber?[ (await github.rest.pulls.get({...repo,pull_number:options.prNumber,request})).data ]:await boundedPages(page=>github.rest.pulls.list({...repo,state:'open',per_page:100,page,request}));
 let examined=0,dispatched=0;
 for(const listed of pulls){
  if(!id(listed.number)||typeof listed.head?.repo?.full_name!=='string'||!same(listed.base?.repo?.full_name,repo)||!sha.test(listed.head.sha||''))continue;
  const {data:pull}=await github.rest.pulls.get({...repo,pull_number:listed.number,request});
  if(pull.head?.sha!==listed.head.sha)continue;
  examined++;
  const prior=await ownedGate(github,repo,pull,workflow);
  const snapshot={prNumber:pull.number,headSha:pull.head.sha,headRef:pull.head.ref,baseSha:pull.base.sha,baseRef:pull.base.ref,sourceSha:pull.merge_commit_sha};
  const evidence={schemaVersion:1,...snapshot,controllerSha:controller.sha,controllerRef:controller.ref,controllerAttempt:options.runAttempt};
  const write=async(conclusion,title,extra={})=>{
   const args={...repo,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`,status:'completed',conclusion,request,output:{title,summary:JSON.stringify({...evidence,...extra})}};
   if(prior)await github.rest.checks.update({...args,check_run_id:prior.check.id});
   else await github.rest.checks.create({...args,name,head_sha:pull.head.sha,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`});
  };
  const admitted=config.admitted&&same(pull.head?.repo?.full_name,repo)&&pull.state==='open'&&pull.draft===false&&['ready-for-ci','ci-linux'].every(label=>pull.labels?.some(value=>value.name===label));
  if(!admitted){await write('success','Dedicated source qualification: not admitted',{notApplicable:true});continue;}
  if(!sha.test(config.controllerSha||'')||config.controllerSha!==controller.sha||!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest||'')||!/^[a-f0-9]{64}$/.test(config.harnessDigest||'')){await write('failure','Reviewed execution configuration is incomplete');continue;}
  try{const current=await verifyCurrentDedicatedSource(github,repo,snapshot);snapshot.mergeParents=current.mergeParents;evidence.mergeParents=current.mergeParents;}
  catch(error){await write('failure','Current source candidate is not available');if(!(error instanceof Error))throw error;continue;}
  const requester=await currentRequester(github,repo,snapshot);
  if(!requester){
   const duplicate=prior?.evidence.refreshDispatchedAt&&prior.evidence.sourceSha===snapshot.sourceSha&&prior.evidence.baseSha===snapshot.baseSha&&Date.now()-Date.parse(prior.evidence.refreshDispatchedAt)<30*60*1000;
   await write('failure','Fresh exact-source hosted and Linux coverage required',duplicate?{refreshDispatchedAt:prior.evidence.refreshDispatchedAt}:{refreshDispatchedAt:new Date().toISOString()});
   if(!duplicate){await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci.yml',ref:'main',inputs:{pr_number:String(pull.number),head_sha:pull.head.sha,base_sha:pull.base.sha,source_sha:pull.merge_commit_sha},request});dispatched++;}
   continue;
  }
  if(requester.status!=='completed'||requester.conclusion!=='success'){await write('failure','Current requesting CI is pending or failed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});continue;}
  try{
   await waitForDedicatedResult(github,{...repo,...snapshot,requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...config,serverUrl:'https://github.com'},{maxAttempts:1});
   await verifyCurrentDedicatedSource(github,repo,snapshot);
   const latest=await currentRequester(github,repo,snapshot);
   if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.conclusion!=='success')throw new Error('New requesting attempt superseded coverage');
   await write('success','Current exact-source hosted and Linux qualification passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});
  }catch(error){await write('failure','Fresh authenticated Linux evidence is missing or stale');if(!(error instanceof Error))throw error;}
 }
 return{examined,dispatched};
}
