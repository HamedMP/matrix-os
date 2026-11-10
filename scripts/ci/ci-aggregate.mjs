import {assertNotRoutingCoverage} from './dedicated-isolated.mjs';

const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
export class InvalidCiAggregate extends Error {}

// Authenticate the real Actions job, not a successful suite with only skips.
export async function verifyCiAggregate(github,repo,run){
 const {data}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
 if(!Number.isSafeInteger(data.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)throw new InvalidCiAggregate('Incomplete genuine CI job inventory');
 try{assertNotRoutingCoverage(data.jobs);}catch(error){if(!(error instanceof Error))throw error;throw new InvalidCiAggregate('Routing-only aggregate cannot qualify candidate coverage');}
 const aggregates=data.jobs.filter(job=>job.name==='CI Results');
 const job=aggregates[0],prefix=`https://api.github.com/repos/${repo.owner}/${repo.repo}/check-runs/`;
 if(aggregates.length!==1||job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'||!job.check_run_url?.startsWith(prefix))throw new InvalidCiAggregate('Genuine CI aggregate missing, incomplete or unsuccessful');
 const checkId=Number(job.check_run_url.slice(prefix.length));
 if(!id(checkId))throw new InvalidCiAggregate('Invalid genuine CI aggregate identity');
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 if(check.id!==checkId||check.app?.id!==15368||check.app?.slug!=='github-actions'||check.name!=='CI Results'||check.head_sha!==run.head_sha||check.status!=='completed'||check.conclusion!=='success'||check.details_url!==`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}/job/${job.id}`||(run.check_suite_id!==undefined&&check.check_suite?.id!==run.check_suite_id))throw new InvalidCiAggregate('CI aggregate issuer, suite or source binding mismatch');
 return{jobId:job.id,checkId};
}
