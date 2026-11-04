import {InvalidCiAggregate,verifyCiAggregate} from './ci-aggregate.mjs';

const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const hash=/^[a-f0-9]{40}$/;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const identity=pull=>JSON.stringify([pull.number,pull.state,pull.draft,pull.head?.sha,pull.head?.ref,pull.head?.repo?.full_name,pull.base?.sha,pull.base?.ref,pull.base?.repo?.full_name]);

// Readiness and coverage discovery have different rules. Never filter this
// search to full coverage: a newer metadata suite can mask that older success.
async function newestPrSuite(github,repo,pull,workflow,prNumber){
 const fullName=`${repo.owner}/${repo.repo}`;
 let latest;
 for(let page=1;page<=10;page++){
  const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,event:'pull_request',branch:pull.head.ref,head_sha:pull.head.sha,per_page:100,page,request});
  if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>100||data.workflow_runs.some(run=>!id(run.id)))throw new Error('Invalid required CI history');
  for(const run of data.workflow_runs){
   const associated=run.pull_requests?.some(row=>row.number===prNumber&&row.head?.sha===pull.head.sha);
   const emptyFork=!same(pull.head.repo.full_name,fullName)&&Array.isArray(run.pull_requests)&&run.pull_requests.length===0;
   if(run.workflow_id===workflow.id&&run.path==='.github/workflows/ci.yml'&&run.event==='pull_request'&&run.head_sha===pull.head.sha&&run.head_branch===pull.head.ref&&same(run.repository?.full_name,fullName)&&same(run.head_repository?.full_name,pull.head.repo.full_name)&&(associated||emptyFork)&&(!latest||run.id>latest.id||(run.id===latest.id&&run.run_attempt>latest.run_attempt)))latest=run;
  }
  if(data.workflow_runs.length<100)break;
  if(page===10)throw new Error('Required CI history exceeds bounded coverage');
 }
 return structuredClone(latest);
}
export async function inspectRequiredCiResult(github,repo,prNumber){
 if(!id(prNumber)||prNumber>999999||![repo.owner,repo.repo].every(value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(value)))throw new Error('Invalid required CI request');
 const fullName=`${repo.owner}/${repo.repo}`;
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:prNumber,request});
 const initial=identity(pull),result={ready:false,prNumber,headSha:pull.head?.sha};
 if(pull.number!==prNumber||pull.state!=='open'||pull.draft!==false||!hash.test(pull.head?.sha||'')||!same(pull.base?.repo?.full_name,fullName)||typeof pull.head?.ref!=='string'||!pull.head?.repo?.full_name)return{...result,reason:'PR is not an open, ready revision'};
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected required CI workflow');
 const latest=await newestPrSuite(github,repo,pull,workflow,prNumber);
 if(!latest)return{...result,reason:'CI Results expected: no current-head PR suite'};
 Object.assign(result,{runId:latest.id,runAttempt:latest.run_attempt,checkSuiteId:latest.check_suite_id,url:`https://github.com/${fullName}/actions/runs/${latest.id}`});
 if(!id(latest.run_attempt)||!id(latest.check_suite_id)||latest.status!=='completed'||latest.conclusion!=='success')return{...result,reason:'Newest CI suite is incomplete or unsuccessful'};
 try{await verifyCiAggregate(github,repo,latest);}
 catch(error){if(!(error instanceof InvalidCiAggregate))throw error;return{...result,reason:error.message};}
 const {data:current}=await github.rest.pulls.get({...repo,pull_number:prNumber,request});
 if(identity(current)!==initial)return{...result,reason:'PR revision changed during required CI inspection'};
 const confirmed=await newestPrSuite(github,repo,current,workflow,prNumber);
 if(!confirmed||confirmed.id!==latest.id||confirmed.run_attempt!==latest.run_attempt||confirmed.check_suite_id!==latest.check_suite_id||confirmed.status!=='completed'||confirmed.conclusion!=='success')return{...result,reason:'Newest CI suite changed during required CI inspection'};
 return{...result,ready:true,reason:'Latest PR suite has a successful genuine CI Results aggregate'};
}
