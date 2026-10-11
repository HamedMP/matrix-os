// Only the reviewed default controller may revoke its completed child results.
import {assertDefaultController,liveParentRefSha} from './dedicated-admission.mjs';
const request={timeout:10_000};
const workflowPath='.github/workflows/ci-dedicated.yml';
const sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const eligible=pull=>pull.state==='open'&&pull.draft===false&&['ci-linux','ready-for-ci'].every(name=>pull.labels?.some(label=>label.name===name));
function evidence(check,pull,repo,serverUrl){
 if(!id(check.id)||check.name!=='Dedicated CI Results'||check.app?.slug!=='github-actions'||check.head_sha!==pull.head.sha||check.status!=='completed'||check.conclusion!=='success')return null;
 const prefix=`${serverUrl}/${repo.owner}/${repo.repo}/actions/runs/`;
 if(typeof check.details_url!=='string'||!check.details_url.startsWith(prefix))return null;
 const runId=Number(check.details_url.slice(prefix.length));if(!id(runId))return null;
 if(typeof check.output?.summary!=='string'||check.output.summary.length>4096)return null;
 let value;try{value=JSON.parse(check.output.summary);}catch(error){if(error instanceof SyntaxError)return null;throw error;}
 if(![2,3].includes(value?.schemaVersion)||value.suite!=='qualification'||value.prNumber!==pull.number||value.headSha!==pull.head.sha||![value.baseSha,value.sourceSha,value.controllerSha].every(v=>sha.test(v||''))||value.controllerRef!=='refs/heads/main'||value.controllerWorkflow!==workflowPath||!id(value.controllerAttempt))return null;
 return{...value,runId};
}
export async function reconcileDedicatedChildren(github,repo,controller,options={}){
 assertDefaultController(repo,controller);
 const serverUrl=options.serverUrl??'https://github.com';
 if(serverUrl!=='https://github.com')throw new Error('Unexpected controller API origin');
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci-dedicated.yml',request});
 if(!id(workflow.id)||workflow.path!==workflowPath)throw new Error('Unexpected controller workflow');
 const pulls=[];
 if(options.prNumber!==undefined){
  if(!id(options.prNumber))throw new Error('Invalid reconciliation PR');
  const {data}=await github.rest.pulls.get({...repo,pull_number:options.prNumber,request});pulls.push(data);
 }else{
  for(let page=1;page<=3;page++){
   const {data}=await github.rest.pulls.list({...repo,state:'open',per_page:100,page,request});
   if(!Array.isArray(data)||data.length>100)throw new Error('Invalid bounded open PR list');
   pulls.push(...data);if(data.length<100)break;
   if(page===3)throw new Error('Open PR reconciliation exceeds bounded coverage');
  }
 }
 let invalidated=0;
 for(const listed of pulls){
  if(!id(listed?.number)||!same(listed.head?.repo?.full_name,repo)||!same(listed.base?.repo?.full_name,repo)||!sha.test(listed.head.sha))continue;
  const checks=[];
  for(let page=1;page<=3;page++){
   const {data}=await github.rest.checks.listForRef({...repo,ref:listed.head.sha,filter:'all',per_page:100,page,request});
   if(!Array.isArray(data.check_runs)||data.check_runs.length>100)throw new Error('Invalid bounded child check list');
   checks.push(...data.check_runs);if(data.check_runs.length<100)break;
   if(page===3)throw new Error('Child check reconciliation exceeds bounded coverage');
  }
  for(const check of checks){
   const prior=evidence(check,listed,repo,serverUrl);if(!prior)continue;
   const {data:run}=await github.rest.actions.getWorkflowRun({...repo,run_id:prior.runId,request});
   if(run.id!==prior.runId||run.workflow_id!==workflow.id||!['pull_request_target','workflow_run'].includes(run.event)||![workflowPath,`${workflowPath}@main`,`${workflowPath}@refs/heads/main`].includes(run.path)||(run.event==='pull_request_target'&&run.head_sha!==prior.headSha)||!same(run.repository?.full_name,repo)||!same(run.head_repository?.full_name,repo))continue;
   const {data:live}=await github.rest.pulls.get({...repo,pull_number:listed.number,request});
   if(live.head?.sha!==listed.head.sha||!same(live.head?.repo?.full_name,repo)||!same(live.base?.repo?.full_name,repo))continue;
   const parentSha=await liveParentRefSha(github,repo,live.base.ref);
   if(eligible(live)&&parentSha===prior.baseSha&&live.base.sha===prior.baseSha&&live.base.ref===prior.baseRef&&live.merge_commit_sha===prior.sourceSha)continue;
   // Revoke only our own source result. CI Source Qualification separately
   // blocks stale parent state; genuine Actions-owned CI Results stays intact.
   // A fresh remote result alone cannot refresh old-base hosted qualification.
   await github.rest.checks.update({...repo,check_run_id:check.id,status:'completed',conclusion:'failure',request,
    output:{title:'Stack qualification revoked',summary:JSON.stringify({...prior,revoked:true})}});
   invalidated++;
  }
 }
 return{examined:pulls.length,invalidated};
}
