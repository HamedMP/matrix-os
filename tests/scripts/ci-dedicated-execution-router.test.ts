import {describe,expect,it,vi} from 'vitest';
import {routeControllerEvent,routeManualCi} from '../../scripts/ci/dedicated-execution-router.mjs';
const pin='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),merge='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'},snapshot={pin,flag:'true'};
function fixture(title:string){
 const run={id:321,run_attempt:1,workflow_id:98,path:'.github/workflows/ci.yml',event:'workflow_dispatch',head_branch:'main',head_sha:pin,status:'completed',conclusion:'success',display_title:title,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const variables=vi.fn(async()=>{throw new Error('GITHUB_TOKEN has no Variables read authority');});
 const github={rest:{actions:{listRepoVariables:variables,getRepoVariable:variables,getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),getWorkflowRun:vi.fn(async()=>({data:run})),listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[{name:'CI Results',steps:[{name:'Summarize isolated CI routing',status:'completed',conclusion:'success'}]}]}})),createWorkflowDispatch:vi.fn()},pulls:{get:vi.fn(async()=>({data:{state:'open',draft:false,head:{sha:'f'.repeat(40)},base:{ref:'main',sha:base}}}))}}};
 return{github,variables,run,context:{eventName:'workflow_run',ref:'refs/heads/main',payload:{action:'completed',workflow_run:run}}};
}
describe('secret-free isolated Main routers',()=>{
 it('does not create reconciliation work for a Main routing-only run',async()=>{
  const f=fixture(`CI routing-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toMatchObject({dispatched:false});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rejects coverage from a routing-only rerun even when its historical title remains a refresh marker',async()=>{
  const f=fixture(`CI refresh-v1 pr=2454 head=${head} base=${base} merge=${merge}`);
  await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toMatchObject({dispatched:false});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('benignly skips a superseded manual request using protected vars without attempting the Variables API',async()=>{
  const f=fixture('CI');
  await expect(routeManualCi(f.github,repo,pin,{pr_number:'2454',head_sha:head,base_sha:base,source_sha:merge},snapshot)).resolves.toEqual({routed:true,stale:true});
  expect(f.variables).not.toHaveBeenCalled();expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rejects a disabled or inconsistent protected router snapshot before reading a requester',async()=>{
  for(const config of [{pin,flag:'false'},{pin:base,flag:'true'}]){
   const f=fixture('CI');await expect(routeControllerEvent(f.github,repo,pin,f.context,config)).rejects.toThrow();
   expect(f.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();expect(f.variables).not.toHaveBeenCalled();
  }
 });
});


it.each(['pull_request','isolated-placeholder'])('routes genuine %s execution to the proved distinct commit without Variables API access',async kind=>{
 const f=fixture(`CI coverage-v1 · ${merge}`),execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`;
 Object.assign(f.run,{event:'pull_request',head_branch:'child',head_sha:head,status:'queued',conclusion:null});
 if(kind==='isolated-placeholder')Object.assign(f.run,{event:'workflow_dispatch',head_branch:branch,head_sha:execution,display_title:'CI'});
 f.context.payload.action='requested';
 const github:any=f.github;
 github.rest.repos={getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:args.branch===branch?execution:pin}}})),compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}))};
 github.rest.git={getCommit:vi.fn(async(args:any)=>({data:{sha:args.commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))};
 github.rest.actions.getWorkflow.mockImplementation(async(args:any)=>({data:{id:args.workflow_id==='ci.yml'?98:99,path:`.github/workflows/${args.workflow_id}`}}));
 github.rest.actions.listWorkflowRuns=vi.fn(async()=>({data:{workflow_runs:[]}}));
 await expect(routeControllerEvent(github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:true,mode:'qualification'});
 expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith(expect.objectContaining({workflow_id:'ci-dedicated.yml',ref:branch,inputs:{controller_mode:'qualification',requesting_run_id:'321',requesting_run_attempt:'1',requesting_action:'requested'}}));
 expect(f.variables).not.toHaveBeenCalled();
});


it('does not create reconciliation work for ordinary manual Main CI without a PR marker',async()=>{
 const f=fixture(`CI coverage-v1 · ${pin}`);
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();expect(f.variables).not.toHaveBeenCalled();
});

it.each(['requested','completed'])('benignly ignores an authenticated fork PR %s event without dispatching work',async action=>{
 const f=fixture(`CI coverage-v1 · ${merge}`);
 Object.assign(f.run,{event:'pull_request',head_branch:'fork-feature',head_sha:head,head_repository:{full_name:'contributor/matrix-os'}});
 f.context.payload.action=action;
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).resolves.toEqual({dispatched:false});
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 expect(f.variables).not.toHaveBeenCalled();
});

it.each(['base-repository','workflow-id','workflow-path','manual-event','push-event','missing-head','malformed-head'])('does not use the fork no-op to hide %s authentication failure',async kind=>{
 const f=fixture(`CI coverage-v1 · ${merge}`);
 Object.assign(f.run,{event:'pull_request',head_repository:{full_name:'contributor/matrix-os'}});
 if(kind==='base-repository')f.run.repository.full_name='attacker/matrix-os';
 if(kind==='workflow-id')f.run.workflow_id=99;
 if(kind==='workflow-path')f.run.path='.github/workflows/untrusted.yml';
 if(kind==='manual-event')f.run.event='workflow_dispatch';
 if(kind==='push-event')f.run.event='push';
 if(kind==='missing-head')f.run.head_repository.full_name='';
 if(kind==='malformed-head')f.run.head_repository.full_name='not-a-repository';
 await expect(routeControllerEvent(f.github,repo,pin,f.context,snapshot)).rejects.toThrow('Untrusted controller bridge requester');
 expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});
