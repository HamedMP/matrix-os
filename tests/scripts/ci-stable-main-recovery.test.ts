import {describe,expect,it} from 'vitest';
import {reconcileSourceQualification} from '../../scripts/ci/dedicated-source-gate.mjs';
import {pins,repo,stableMainFixture} from './helpers/stable-main-fixture';

function recoveryFixture(){
 const f=stableMainFixture();f.pull.labels=[];f.complete();
 const started=new Date(Date.now()-20_000).toISOString();
 const prior:any={id:10,name:'CI Source Qualification',head_sha:pins.head,status:'in_progress',app:{id:5271502,slug:'matrix-ci-gate'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify({schemaVersion:1,...f.snapshot,sourceBindings:[{baseSha:pins.base,sourceSha:pins.source}],admittedPreviously:true,controllerSha:pins.controller,controllerRef:'refs/heads/main',controllerAttempt:1,executionMode:'hosted-only',recoveryStartedAt:started,recoveryAfterRunId:320})}};
 f.github.rest.checks.listForRef.mockImplementation(async({check_name})=>({data:{check_runs:check_name==='CI Source Qualification'?[prior]:[f.check]}}));
 f.gateGithub.rest.checks.update.mockImplementation(async(args:any)=>{Object.assign(prior,args);if(args.status==='in_progress')delete prior.conclusion;return{data:prior};});
 f.gateGithub.rest.checks.create.mockImplementation(async(args:any)=>{Object.assign(prior,args);if(args.status==='in_progress')delete prior.conclusion;return{data:prior};});
 const hosted=(id:number,base=pins.base,source=pins.source)=>({...f.ci,id,event:'workflow_dispatch',head_sha:pins.controller,head_branch:'main',created_at:new Date(Date.now()-10_000).toISOString(),display_title:`CI hosted-refresh-v1 pr=2454 head=${pins.head} base=${base} merge=${source}`});
 const aggregate=(id:number)=>{
  f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:1,jobs:[{id:30,run_id:id,run_attempt:1,name:'CI Results',head_sha:pins.controller,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/33'}]}} as any);
  f.github.rest.checks.get.mockResolvedValue({data:{...f.aggregate,head_sha:pins.controller,details_url:`https://github.com/HamedMP/matrix-os/actions/runs/${id}/job/30`}});
 };
 const reconcile=()=>reconcileSourceQualification(f.github,repo,f.origin,{runId:123,runAttempt:1,prNumber:2454,gateAppId:5271502,gateGithub:f.gateGithub});
 return {...f,prior,hosted,aggregate,reconcile,evidence:()=>JSON.parse(prior.output.summary)};
}

describe('main PR hosted recovery source and generation binding',()=>{
 it('binds the exact requester selected after discovery to its own main source',async()=>{
  const f=recoveryFixture();f.advance();
  const older=f.hosted(321),selected=f.hosted(322,pins.advanced,pins.newSource);let lists=0;
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async()=>({data:{workflow_runs:++lists<=2?[older]:[selected,older]}}));f.aggregate(322);
  await f.reconcile();
  expect(f.prior.conclusion).toBe('success');
  expect(f.evidence()).toMatchObject({requestingRunId:322,baseSha:pins.advanced,sourceSha:pins.newSource,mergeParents:[pins.advanced,pins.head],recoveryAfterRunId:320});
  expect(f.github.rest.repos.getCommit).toHaveBeenCalledWith(expect.objectContaining({ref:pins.newSource}));
 });
 it('fails closed when the selected requester source is not its merge-parent tuple',async()=>{
  const f=recoveryFixture();f.advance();const older=f.hosted(321),selected=f.hosted(322,pins.base,pins.newSource);let lists=0;
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async()=>({data:{workflow_runs:++lists<=2?[older]:[selected,older]}}));f.aggregate(322);
  await f.reconcile();expect(f.prior.conclusion).toBe('failure');
 });
 it('does not reset a new recovery generation to its first successful replacement',async()=>{
  const f=recoveryFixture();f.advance();
  const old=f.hosted(321),delegated={...f.hosted(400,pins.advanced,pins.newSource),created_at:new Date(Date.now()-1000).toISOString(),display_title:`CI refresh-v1 pr=2454 head=${pins.head} base=${pins.advanced} merge=${pins.newSource}`};
  f.prior.output.summary=JSON.stringify({...f.evidence(),executionMode:undefined,recoveryStartedAt:undefined,recoveryAfterRunId:undefined});
  f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[delegated,old]}});
  await f.reconcile();
  expect(f.evidence()).toMatchObject({baseSha:pins.advanced,sourceSha:pins.newSource,recoveryAfterRunId:400});
  const boundary=f.evidence().recoveryStartedAt;
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  const replacement={...f.hosted(401,pins.advanced,pins.newSource),created_at:new Date(Date.now()+1000).toISOString()};
  f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[replacement,delegated,old]}});f.aggregate(401);
  await f.reconcile();
  expect(f.prior.conclusion).toBe('success');
  expect(f.evidence()).toMatchObject({requestingRunId:401,baseSha:pins.advanced,sourceSha:pins.newSource,recoveryStartedAt:boundary,recoveryAfterRunId:400});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
 });
 it('retains a running generation when main advances again before its replacement arrives',async()=>{
  const f=recoveryFixture();const hosted=f.hosted(321);f.advance();f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[hosted]}});f.aggregate(321);
  await f.reconcile();
  expect(f.prior.conclusion).toBe('success');
  expect(f.evidence()).toMatchObject({requestingRunId:321,baseSha:pins.base,sourceSha:pins.source,recoveryAfterRunId:320});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it('rechecks the requester source as well as its identity before success',async()=>{
  const f=recoveryFixture();f.advance();const hosted=f.hosted(321);f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[hosted]}});f.aggregate(321);
  const jobs=f.github.rest.actions.listJobsForWorkflowRun.getMockImplementation()!;
  f.github.rest.actions.listJobsForWorkflowRun.mockImplementation(async(args:any)=>{hosted.display_title=f.hosted(321,pins.advanced,pins.newSource).display_title;return jobs(args);});
  await f.reconcile();expect(f.prior.conclusion).toBe('failure');
 });
 it.each(['failure','cancelled','pending','success'])('starts a new generation after a newer ordinary %s PR requester',async outcome=>{
  const f=recoveryFixture();f.advance();const hosted=f.hosted(321);
  const newer={...f.ci,id:323,status:outcome==='pending'?'queued':'completed',conclusion:outcome==='pending'?null:outcome,display_title:`CI coverage-v1 · ${pins.newSource}`};
  f.github.rest.actions.listWorkflowRuns.mockResolvedValue({data:{workflow_runs:[newer,hosted]}});f.aggregate(321);
  await f.reconcile();
  expect(f.prior.status).toBe('in_progress');expect(f.prior).not.toHaveProperty('conclusion');
  expect(f.evidence()).toMatchObject({recoveryAfterRunId:323,baseSha:pins.advanced,sourceSha:pins.newSource});
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 });

 it('rechecks the source on the final all-mode recovery supersession read',async()=>{
  const f=recoveryFixture();f.advance();const hosted=f.hosted(321);let lists=0;
  f.github.rest.actions.listWorkflowRuns.mockImplementation(async()=>{
   if(++lists>=7)hosted.display_title=f.hosted(321,pins.advanced,pins.newSource).display_title;
   return {data:{workflow_runs:[hosted]}};
  });f.aggregate(321);
  await f.reconcile();expect(f.prior.conclusion).toBe('failure');
 });

});
