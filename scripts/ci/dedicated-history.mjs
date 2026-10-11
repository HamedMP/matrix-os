// REST workflow runs are newest-first. Search relevant events/branches, not
// schedules or unrelated main pushes; an established newest match ends a scan.
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const newer=(a,b)=>!b||a.id>b.id||(a.id===b.id&&a.run_attempt>b.run_attempt);
export async function newestWorkflowRun(github,repo,workflow,accept,scope){
 const filters=scope.kind==='controller'?
  [{event:'pull_request_target',branch:scope.headRef,head_sha:scope.headSha},
   {event:'workflow_run',branch:scope.headRef},{event:'workflow_run',branch:'main'}]:
  [{event:'pull_request',branch:scope.headRef,head_sha:scope.headSha},{event:'workflow_dispatch',branch:'main'}];
 const states=[...new Map(filters.map(filter=>[JSON.stringify(filter),{filter,page:0,rows:[]}])).values()];
 let best;
 const load=async state=>{
  const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,...state.filter,per_page:100,page:++state.page,request});
  if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>100||data.workflow_runs.some(run=>!id(run.id)))throw new Error('Invalid bounded workflow run history');
  state.rows=data.workflow_runs;
  for(const run of state.rows)if(accept(run)){
   if(!id(run.run_attempt))throw new Error('Invalid authenticated workflow attempt');
   if(newer(run,best))best=run;
  }
 };
 for(const state of states)await load(state);
 for(const state of states){
  while(state.rows.length===100&&(!best||Math.min(...state.rows.map(run=>run.id))>best.id)){
   if(state.page===3)throw new Error('Relevant workflow history exceeds bounded coverage');
   await load(state);
  }
 }
 return best;
}
