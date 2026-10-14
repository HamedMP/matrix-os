// The App source gate independently checks full hosted recovery, never exit-only evidence.
export const HOSTED_LANES=Object.freeze(['Type Check','Shell Production Build','Pattern Scan','React Doctor','Sync Client Package','Agent SDK 0.3.251 Compatibility',...Array.from({length:4},(_,i)=>`Unit Tests (${i+1}/4)`),'Funded Settlement PostgreSQL','Protected Funded Host Root Contracts','Docs Contract Tests','OS View Parity','E2E Tests (general)','E2E Tests (electron)','CI Backend Decision']);
const request={timeout:10000};
const id=value=>Number.isSafeInteger(value)&&value>0;
export async function verifyFullHostedCoverage(github,repo,run){
 if(!id(run.id)||!id(run.run_attempt)||!/^[a-f0-9]{40}$/.test(run.head_sha||'')||run.status!=='completed'||run.conclusion!=='success')throw new Error('Hosted requesting run is not successful');
 const {data}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
 if(!Number.isSafeInteger(data.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)throw new Error('Full hosted job inventory incomplete');
 for(const name of [...HOSTED_LANES,'CI Results']){
  const matches=data.jobs.filter(job=>job.name===name);
  if(matches.length!==1)throw new Error('Required hosted lane missing or duplicated');
  const job=matches[0];
  if(!id(job.id)||job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success')throw new Error('Required hosted lane failed or stale');
 }
 await verifyActionsAggregate(github,repo,data.jobs,run);
 return {hostedLaneCount:HOSTED_LANES.length};
}

// One Actions-issued CI Results aggregate, for exactly this run attempt and head, that GitHub
// itself completed successfully. Shared by every gate that trusts a run's aggregate.
export async function verifyActionsAggregate(github,repo,jobs,run){
 const matches=jobs.filter(job=>job.name==='CI Results');
 if(matches.length!==1)throw new Error('CI Results aggregate missing or duplicated');
 const [job]=matches,full=`${repo.owner}/${repo.repo}`,prefix=`https://api.github.com/repos/${full}/check-runs/`;
 if(!id(job.id)||job.run_id!==run.id||job.run_attempt!==run.run_attempt||job.head_sha!==run.head_sha||job.status!=='completed'||job.conclusion!=='success'||!job.check_run_url?.startsWith(prefix))throw new Error('CI Results aggregate failed or stale');
 const checkId=Number(job.check_run_url.slice(prefix.length));if(!id(checkId))throw new Error('Invalid CI Results aggregate identity');
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 if(check.id!==checkId||check.name!=='CI Results'||check.app?.slug!=='github-actions'||check.head_sha!==run.head_sha||check.status!=='completed'||check.conclusion!=='success'||!check.details_url?.startsWith(`https://github.com/${full}/actions/runs/${run.id}/`))throw new Error('CI Results aggregate is not genuine');
}
