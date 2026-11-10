import {execFileSync} from 'node:child_process';
import {inspectRequiredCiResult} from './required-result.mjs';

// GET-only adapter. No dispatch, rerun, status write, body edit or merge.
function get(route,params={}){
 const query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));
 const text=execFileSync('gh',['api','--method','GET',`${route}${query.size?'?'+query:''}`],{encoding:'utf8',timeout:15_000,maxBuffer:4*1024*1024});
 return{data:JSON.parse(text)};
}
try{
 const [pr,repository='HamedMP/matrix-os',...extra]=process.argv.slice(2);
 if(extra.length||!pr||!/^[1-9][0-9]{0,5}$/.test(pr)||!/^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository))throw new Error('Usage: node scripts/ci/check-pr-readiness.mjs <pr> [owner/repo]');
 const [owner,repo]=repository.split('/'),prefix=`repos/${repository}`;
 const github={rest:{
  pulls:{get:({pull_number})=>get(`${prefix}/pulls/${pull_number}`)},
  actions:{getWorkflow:()=>get(`${prefix}/actions/workflows/ci.yml`),
   listWorkflowRuns:({workflow_id,event,branch,head_sha,per_page,page})=>get(`${prefix}/actions/workflows/${workflow_id}/runs`,{event,branch,head_sha,per_page,page}),
   listJobsForWorkflowRun:({run_id,filter,per_page})=>get(`${prefix}/actions/runs/${run_id}/jobs`,{filter,per_page})},
  checks:{get:({check_run_id})=>get(`${prefix}/check-runs/${check_run_id}`)},
 }};
 const result=await inspectRequiredCiResult(github,{owner,repo},Number(pr));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.ready?0:1;
}catch(error){
 console.error(error instanceof Error?error.message:'Required CI inspection failed');process.exitCode=2;
}
