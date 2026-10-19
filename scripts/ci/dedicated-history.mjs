// REST workflow runs are newest-first. Search relevant events/branches, not
// schedules or unrelated main pushes; an established newest match ends a scan.
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const newer=(a,b)=>!b||a.id>b.id||(a.id===b.id&&a.run_attempt>b.run_attempt);
function creationTime(value){
 const normalized=typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)?value.length===20?value.slice(0,-1)+'.000Z':value:null;
 const time=normalized===null?NaN:Date.parse(normalized);
 if(!Number.isFinite(time)||new Date(time).toISOString()!==normalized)throw new Error('Invalid workflow history creation bound');
 return time;
}
// PTR admission may precede its CI run by seconds. A rerun keeps the original
// creation time, so this conservative floor never truncates its earlier attempt.
export const requesterHistoryFloor=created=>new Date(creationTime(created)-10*60_000).toISOString();
export async function newestWorkflowRun(github,repo,workflow,accept,scope){
 const notBefore=scope.notBefore===undefined?undefined:new Date(creationTime(scope.notBefore)).toISOString();
 const pins=[...new Set(scope.controllerShas??(scope.controllerSha?[scope.controllerSha]:[]))];
 if(pins.length>4||pins.some(pin=>!/^[a-f0-9]{40}$/.test(pin||'')))throw new Error('Invalid bounded execution history pins');
 const isolated=pins.map(pin=>({event:'workflow_dispatch',branch:`ci-execution/${pin}`}));
 const filters=scope.sourceKind==='main'?(scope.kind==='controller'?[{event:'workflow_run',branch:'main',head_sha:scope.headSha}]:[{event:'push',branch:'main',head_sha:scope.headSha}]):scope.kind==='controller'?
  [{event:'pull_request_target',branch:scope.headRef,head_sha:scope.headSha},
   {event:'workflow_run',branch:scope.headRef},{event:'workflow_run',branch:'main'},...isolated]:
  [{event:'pull_request',branch:scope.headRef,head_sha:scope.headSha},{event:'workflow_dispatch',branch:'main'},...isolated];
 const states=[...new Map(filters.map(filter=>[JSON.stringify(filter),{filter:notBefore?{...filter,created:`>=${notBefore}`}:filter,cursor:Infinity,page:0,rows:[]}])).values()];
 let best,requests=0;
 const load=async state=>{
  if(++requests>100)throw new Error('Relevant workflow history exceeds bounded request coverage');
  const {data}=await github.rest.actions.listWorkflowRuns({...repo,workflow_id:workflow.id,...state.filter,per_page:100,page:++state.page,request});
  if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>100||data.workflow_runs.some(run=>!id(run.id)))throw new Error('Invalid bounded workflow run history');
  state.rows=data.workflow_runs;
  for(const run of state.rows)if(newer(run,best)&&await accept(run)){
   if(!id(run.run_attempt))throw new Error('Invalid authenticated workflow attempt');
   if(newer(run,best))best=run;
  }
 };
 for(const state of states)await load(state);
 for(const state of states){
  while(state.rows.length===100&&(!best||Math.min(...state.rows.map(run=>run.id))>best.id)){
   if(state.page>=3){
    // GitHub caps a filtered run search at 1,000 rows. Advance an inclusive
    // creation-time cursor instead of treating unrelated controller traffic as
    // missing evidence. Keep boundary-second rows: several runs may share it.
    const times=state.rows.map(run=>Date.parse(run.created_at));
    if(times.some(time=>!Number.isFinite(time)))throw new Error('Invalid bounded workflow creation history');
    const oldest=Math.min(...times);
    if(oldest<state.cursor){state.filter={...state.filter,created:notBefore?`${notBefore}..${new Date(oldest).toISOString()}`:`<=${new Date(oldest).toISOString()}`};state.cursor=oldest;state.page=0;}
    else if(state.page>=10)throw new Error('Same-second workflow history exceeds bounded API coverage');
   }
   await load(state);
  }
 }
 return best;
}
