// All-PR freshness context, owned exclusively by the default controller.
// CI Results remains the genuine Actions aggregate and is never modified here.
import {assertDefaultController,verifyCurrentDedicatedSource,verifyCurrentHostedSource} from './dedicated-admission.mjs';
import {authenticatedRequestingRun} from './dedicated-refresh.mjs';
import {waitForDedicatedResult} from './dedicated-result.mjs';
import {readReviewedConfiguration} from './dedicated-api.mjs';
import {newestWorkflowRun} from './dedicated-history.mjs';
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
async function ownedGate(github,repo,pull,workflow,appId){
 const {data:legacy}=await github.rest.checks.listForRef({...repo,ref:pull.head.sha,check_name:'Dedicated CI Results',filter:'latest',per_page:100,page:1,request});
 if(!Array.isArray(legacy.check_runs)||legacy.check_runs.length>100)throw new Error('Invalid bounded legacy gate history');
 const history=legacy.check_runs.some(check=>check.name==='Dedicated CI Results'&&check.head_sha===pull.head.sha);
 for(let page=1;page<=3;page++){
 const {data}=await github.rest.checks.listForRef({...repo,ref:pull.head.sha,check_name:name,app_id:appId,filter:'latest',per_page:100,page,request});
 if(!Array.isArray(data.check_runs)||data.check_runs.length>100)throw new Error('Invalid bounded source gate history');
 for(const check of data.check_runs.filter(check=>check.name===name&&check.app?.id===appId&&check.app?.slug!=='github-actions'&&check.head_sha===pull.head.sha).sort((a,b)=>b.id-a.id)){
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
  return{prior:{check,evidence},history};
 }
 if(data.check_runs.length<100)return{prior:null,history};
 }
 throw new Error('Relevant source gate history exceeds bounded coverage');
}
async function currentRequester(github,repo,snapshot,options={}){
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected refresh CI definition');
 return newestWorkflowRun(github,repo,workflow,run=>{
  const authenticated=authenticatedRequestingRun(run,repo,snapshot,workflow)||(options.allModes&&authenticatedRequestingRun(run,repo,{...snapshot,executionMode:undefined},workflow));
  if(!authenticated)return false;
  if(options.afterId!==undefined&&(run.id<=options.afterId||!Number.isFinite(Date.parse(run.created_at))||Date.parse(run.created_at)<Date.parse(options.notBefore)))return false;
  return true;
 },{kind:'requester',headSha:snapshot.headSha,headRef:snapshot.headRef});
}
async function verifyHostedReplacement(github,repo,run){
 const {data}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
 if(!Number.isSafeInteger(data.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)throw new Error('Hosted replacement job inventory incomplete');
 const jobs=data.jobs.filter(job=>job.name==='CI Results');
 if(jobs.length!==1)throw new Error('Genuine hosted CI Results missing');
 const job=jobs[0],prefix=`https://api.github.com/repos/${repo.owner}/${repo.repo}/check-runs/`;
 if(job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'||!job.check_run_url?.startsWith(prefix))throw new Error('Hosted replacement aggregate is not successful');
 const checkId=Number(job.check_run_url.slice(prefix.length));if(!id(checkId))throw new Error('Invalid hosted aggregate check identity');
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 if(check.id!==checkId||check.name!=='CI Results'||check.app?.slug!=='github-actions'||check.head_sha!==run.head_sha||check.status!=='completed'||check.conclusion!=='success'||!check.details_url?.startsWith(`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}/`))throw new Error('Hosted aggregate check is not bound to the requesting run');
}
async function settings(github,repo){
 const values=await readReviewedConfiguration(github,repo);
 return{controllerSha:values.MATRIX_CI_CONTROLLER_SHA,admitted:values.MATRIX_CI_DEDICATED_ENABLED==='true'||values.MATRIX_CI_DEDICATED_SHADOW==='true',mode:values.MATRIX_CI_DEDICATED_ENABLED==='true'?'delegated':'shadow',imageDigest:values.MATRIX_CI_RUNNER_IMAGE_DIGEST,harnessDigest:values.MATRIX_CI_RUNNER_HARNESS_DIGEST};
}
export async function reconcileSourceQualification(github,repo,controller,options){
 assertDefaultController(repo,controller);
 if(!id(options.gateAppId)||!options.gateGithub?.rest?.checks||options.gateGithub===github)throw new Error('Protected dedicated App gate issuer is required');
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
  const {prior,history}=await ownedGate(github,repo,pull,workflow,options.gateAppId);
  const snapshot={prNumber:pull.number,headSha:pull.head.sha,headRef:pull.head.ref,baseSha:pull.base.sha,baseRef:pull.base.ref,sourceSha:pull.merge_commit_sha};
  const admitted=config.admitted&&same(pull.head?.repo?.full_name,repo)&&pull.state==='open'&&pull.draft===false&&['ready-for-ci','ci-linux'].every(label=>pull.labels?.some(value=>value.name===label));
  const previouslyAdmitted=history||Boolean(prior&&(prior.evidence.admittedPreviously===true||prior.evidence.notApplicable!==true));
  const recovery=!admitted&&previouslyAdmitted;
  if(recovery)snapshot.executionMode='hosted-only';
  const evidence={schemaVersion:1,admittedPreviously:previouslyAdmitted||admitted,...snapshot,controllerSha:controller.sha,controllerRef:controller.ref,controllerAttempt:options.runAttempt};
  const write=async(conclusion,title,extra={})=>{
   const args={...repo,details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${options.runId}`,status:'completed',conclusion,request,output:{title,summary:JSON.stringify({...evidence,...extra})}};
   const {data:written}=prior?await options.gateGithub.rest.checks.update({...args,check_run_id:prior.check.id}):await options.gateGithub.rest.checks.create({...args,name,head_sha:pull.head.sha});
   if(written.app?.id!==options.gateAppId||written.app?.slug==='github-actions'||written.name!==name||written.head_sha!==pull.head.sha)throw new Error('Dedicated gate App issuer response mismatch');
  };
  if(!admitted&&!recovery){await write('success','Dedicated source qualification: not admitted',{notApplicable:true});continue;}
  if(admitted&&(!sha.test(config.controllerSha||'')||config.controllerSha!==controller.sha||!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest||'')||!/^[a-f0-9]{64}$/.test(config.harnessDigest||''))){await write('failure','Reviewed execution configuration is incomplete');continue;}
  try{const current=await(recovery?verifyCurrentHostedSource:verifyCurrentDedicatedSource)(github,repo,snapshot);snapshot.mergeParents=current.mergeParents;evidence.mergeParents=current.mergeParents;}
  catch(error){await write('failure','Current source candidate is not available');if(!(error instanceof Error))throw error;continue;}
  let requester;
  try{
   if(recovery){
    const old=prior?.evidence;
    const sameRecovery=old?.executionMode==='hosted-only'&&old.headSha===snapshot.headSha&&old.baseSha===snapshot.baseSha&&old.sourceSha===snapshot.sourceSha&&Number.isFinite(Date.parse(old.recoveryStartedAt))&&Number.isSafeInteger(old.recoveryAfterRunId)&&old.recoveryAfterRunId>=0;
    const latest=await currentRequester(github,repo,snapshot,{allModes:true});
    const delegatedAgain=latest&&!latest.display_title.startsWith('CI hosted-refresh-v1 ')&&latest.id>(sameRecovery?old.recoveryAfterRunId:0);
    evidence.recoveryStartedAt=sameRecovery&&!delegatedAgain?old.recoveryStartedAt:new Date(Math.floor(Date.now()/1000)*1000).toISOString();
    evidence.recoveryAfterRunId=sameRecovery&&!delegatedAgain?old.recoveryAfterRunId:latest?.id??0;
   }
   requester=await currentRequester(github,repo,snapshot,recovery?{afterId:evidence.recoveryAfterRunId,notBefore:evidence.recoveryStartedAt}:{});
  }catch(error){await write('failure','Fresh requesting CI discovery failed');if(!(error instanceof Error))throw error;continue;}
  if(!requester){
   const duplicate=prior?.evidence.refreshDispatchedAt&&prior.evidence.executionMode===snapshot.executionMode&&prior.evidence.sourceSha===snapshot.sourceSha&&prior.evidence.baseSha===snapshot.baseSha&&(!recovery||(prior.evidence.recoveryStartedAt===evidence.recoveryStartedAt&&prior.evidence.recoveryAfterRunId===evidence.recoveryAfterRunId))&&Date.now()-Date.parse(prior.evidence.refreshDispatchedAt)<30*60*1000;
   await write('failure',recovery?'Fresh exact-source hosted replacement required':'Fresh exact-source hosted and Linux coverage required',duplicate?{refreshDispatchedAt:prior.evidence.refreshDispatchedAt}:{refreshDispatchedAt:new Date().toISOString()});
   if(!duplicate){await github.rest.actions.createWorkflowDispatch({...repo,workflow_id:'ci.yml',ref:'main',inputs:{pr_number:String(pull.number),head_sha:pull.head.sha,base_sha:pull.base.sha,source_sha:pull.merge_commit_sha,...(recovery?{execution_mode:'hosted-only'}:{})},request});dispatched++;}
   continue;
  }
  if(requester.status!=='completed'||requester.conclusion!=='success'){await write('failure','Current requesting CI is pending or failed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt});continue;}
  try{
   if(recovery)await verifyHostedReplacement(github,repo,requester);
   else await waitForDedicatedResult(github,{...repo,...snapshot,requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...config,serverUrl:'https://github.com'},{maxAttempts:1});
   const currentPull=await(recovery?verifyCurrentHostedSource:verifyCurrentDedicatedSource)(github,repo,snapshot);
   if(recovery&&(await settings(github,repo)).admitted&&['ci-linux','ready-for-ci'].every(label=>currentPull.labels?.some(value=>value.name===label)))throw new Error('Admission changed during hosted recovery');
   const latest=await currentRequester(github,repo,snapshot,recovery?{afterId:evidence.recoveryAfterRunId,notBefore:evidence.recoveryStartedAt}:{});
   if(latest?.id!==requester.id||latest.run_attempt!==requester.run_attempt||latest.conclusion!=='success')throw new Error('New requesting attempt superseded coverage');
   if(recovery){const newest=await currentRequester(github,repo,snapshot,{allModes:true});if(newest?.id!==requester.id||newest.run_attempt!==requester.run_attempt)throw new Error('A newer admission superseded hosted recovery');}
   await write('success',recovery?'Current exact-source hosted replacement passed':'Current exact-source hosted and Linux qualification passed',{requestingRunId:requester.id,requestingRunAttempt:requester.run_attempt,...(recovery?{hostedRecovery:true}:{})});
  }catch(error){await write('failure',recovery?'Fresh genuine hosted replacement evidence is missing or stale':'Fresh authenticated Linux evidence is missing or stale');if(!(error instanceof Error))throw error;}
 }
 return{examined,dispatched};
}
