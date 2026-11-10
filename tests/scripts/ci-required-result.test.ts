import {describe,expect,it,vi} from 'vitest';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectRequiredCiResult} from '../../scripts/ci/required-result.mjs';

const repo={owner:'HamedMP',repo:'matrix-os'},head='a'.repeat(40),base='b'.repeat(40);
function fixture(){
 const pull={number:3033,state:'open',draft:false,head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'stack/parent',repo:{full_name:'HamedMP/matrix-os'}}};
 const covered={id:20,run_attempt:2,workflow_id:98,path:'.github/workflows/ci.yml',event:'pull_request',head_sha:head,head_branch:'child',check_suite_id:120,status:'completed',conclusion:'success',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},pull_requests:[{number:3033,head:{sha:head}}],display_title:'CI coverage-v1'};
 const metadata={...covered,id:21,run_attempt:1,check_suite_id:121,display_title:'CI metadata-v1'};
 const job={id:30,run_id:21,run_attempt:1,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',check_run_url:'https://api.github.com/repos/HamedMP/matrix-os/check-runs/33'};
 const check={id:33,name:'CI Results',head_sha:head,status:'completed',conclusion:'success',check_suite:{id:121},app:{id:15368,slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/21/job/30'};
 const history=[metadata,covered];
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:history}})),listJobsForWorkflowRun:vi.fn(async()=>({data:{total_count:1,jobs:[job]}}))},checks:{get:vi.fn(async()=>({data:check}))}}};
 return{pull,covered,metadata,job,check,history,github};
}

describe('current required CI suite readiness',()=>{
 it('replays the green-looking stack fault: a newer renamed/skipped aggregate blocks despite older coverage success',async()=>{
  const f=fixture();f.job.name="(github.event_name == 'pull_request' && github.event.pull_request.draft == true) && 'CI Draft (ignored)' || 'CI Results'";f.job.conclusion='skipped';
  const result=await inspectRequiredCiResult(f.github,repo,3033);
  expect(result).toMatchObject({ready:false,runId:21,checkSuiteId:121});
  expect(result.reason).toContain('aggregate');
  expect(f.github.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
  expect(f.github.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({run_id:21}));
 });
 it('accepts the real Actions aggregate in the newest metadata suite without requiring heavy jobs to rerun',async()=>{
  const f=fixture();const result=await inspectRequiredCiResult(f.github,repo,3033);
  expect(result).toMatchObject({ready:true,runId:21,runAttempt:1,checkSuiteId:121,headSha:head});
  expect(f.github.rest.checks.get).toHaveBeenCalledWith(expect.objectContaining({check_run_id:33}));
 });
 it('does not promote a rerun of an older suite over a newer suite',async()=>{
  const f=fixture();f.covered.run_attempt=10;f.history.reverse();f.metadata.status='in_progress';
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false,runId:21});
  expect(f.github.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
 });
 it.each(['failure','cancelled','skipped',null])('blocks a newest suite with conclusion %s',async conclusion=>{
  const f=fixture();f.metadata.conclusion=conclusion as any;
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false,runId:21});
 });
 it.each(['missing','duplicate','skipped','pending','attempt','head','suite','issuer','url','incomplete','routing'])('blocks an invalid %s aggregate without historical fallback',async kind=>{
  const f=fixture();
  if(kind==='missing')f.job.name='CI Draft (ignored)';
  if(kind==='duplicate')f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:2,jobs:[f.job,{...f.job,id:31}]}});
  if(kind==='skipped')f.job.conclusion='skipped';if(kind==='pending')f.job.status='in_progress';if(kind==='attempt')f.job.run_attempt=2;
  if(kind==='head')f.check.head_sha=base;if(kind==='suite')f.check.check_suite.id=120;if(kind==='issuer')f.check.app.id=1;if(kind==='url')f.check.details_url='https://example.com/';
  if(kind==='incomplete')f.github.rest.actions.listJobsForWorkflowRun.mockResolvedValue({data:{total_count:101,jobs:[f.job]}});
  if(kind==='routing')Object.assign(f.job,{steps:[{name:'Summarize isolated CI routing',status:'completed',conclusion:'success'}]});
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false,runId:21});
 });
 it('fails closed if there is no PR run, never using another head or workflow',async()=>{
  const f=fixture();f.history.splice(0,2,{...f.metadata,head_sha:base},{...f.metadata,workflow_id:99});
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false});
 });
 it('checks later pages instead of assuming API ordering or truncating the newest matching suite',async()=>{
  const f=fixture();f.github.rest.actions.listWorkflowRuns.mockImplementation(async({page}:any)=>({data:{workflow_runs:page===1?Array.from({length:100},(_,i)=>({...f.metadata,id:1000+i,head_sha:base})):[f.metadata]}}));
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:true,runId:21});
 });
 it('reports a changed live head during inspection as blocked',async()=>{
  const f=fixture();f.github.rest.checks.get.mockImplementation(async()=>{f.pull.head.sha=base;return{data:f.check};});
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false});
 });
 it('rejects a newer suite that arrives while the previous aggregate is being inspected',async()=>{
  const f=fixture();f.github.rest.checks.get.mockImplementation(async()=>{f.history.unshift({...f.metadata,id:22,check_suite_id:122});return{data:f.check};});
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false});
 });
 it.each(['draft','closed'])('blocks a %s PR',async kind=>{
  const f=fixture();if(kind==='draft')f.pull.draft=true;else f.pull.state='closed';
  expect(await inspectRequiredCiResult(f.github,repo,3033)).toMatchObject({ready:false});
  expect(f.github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
 });
 it('propagates GitHub API failures instead of claiming the gate passed',async()=>{
  const f=fixture();f.github.rest.checks.get.mockRejectedValue(new Error('denied'));
  await expect(inspectRequiredCiResult(f.github,repo,3033)).rejects.toThrow('denied');
 });
});

it.each(['success','blocked','unavailable'])('runs the real readiness CLI with GET-only requests: %s',state=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'ci-readiness-'));
 try{
  if(state==='blocked')f.job.name='CI Draft (ignored)';
  const data={pull:f.pull,history:f.history,job:f.job,check:f.check};
  const fakeGh=`#!/usr/bin/env node
   import assert from 'node:assert/strict';
   assert.deepEqual(process.argv.slice(2,5),['api','--method','GET']);
   if(${JSON.stringify(state)}==='unavailable')process.exit(1);
   const f=${JSON.stringify(data)},url=new URL(process.argv[5],'https://api.github.com/');
   const path=url.pathname;
   let data;
   if(path.endsWith('/pulls/3033'))data=f.pull;
   else if(path.endsWith('/workflows/ci.yml'))data={id:98,path:'.github/workflows/ci.yml'};
   else if(path.endsWith('/workflows/98/runs')){assert.equal(url.searchParams.get('head_sha'),'${head}');assert.equal(url.searchParams.get('event'),'pull_request');data={workflow_runs:f.history};}
   else if(path.endsWith('/runs/21/jobs'))data={total_count:1,jobs:[f.job]};
   else if(path.endsWith('/check-runs/33'))data=f.check;
   else throw new Error('Unexpected endpoint '+path);
   console.log(JSON.stringify(data));
  `;
  writeFileSync(join(dir,'gh'),fakeGh);chmodSync(join(dir,'gh'),0o755);
  const result=spawnSync(process.execPath,[resolve('scripts/ci/check-pr-readiness.mjs'),'3033'],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:`${dir}:${process.env.PATH}`}});
  expect(result.status,result.stderr).toBe(state==='success'?0:state==='blocked'?1:2);
  if(state!=='unavailable')expect(JSON.parse(result.stdout)).toMatchObject({ready:state==='success',runId:21});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
