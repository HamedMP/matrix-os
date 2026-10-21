import {describe,expect,it,vi} from 'vitest';
import {routeManualCi} from '../../scripts/ci/dedicated-execution-router.mjs';
import {resolveRequestingSource} from '../../scripts/ci/dedicated-refresh.mjs';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';

const repo={owner:'HamedMP',repo:'matrix-os'},fullName='HamedMP/matrix-os';
const pin='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),merge='d'.repeat(40);
const execution='e'.repeat(40),tree='f'.repeat(40),branch=`ci-execution/${pin}`;
const inputs={pr_number:'2781',head_sha:head,base_sha:base,source_sha:merge};
function fixture(){
 const pull={number:2781,state:'open',draft:false,head:{sha:head,ref:'child',repo:{id:10,full_name:fullName}},base:{sha:base,ref:'parent',repo:{id:10,full_name:fullName}},merge_commit_sha:merge,labels:[{name:'fast-ci'},{name:'ready-for-ci'}]};
 const github={rest:{pulls:{get:vi.fn(async()=>({data:pull}))},
  repos:{getBranch:vi.fn(async({branch:ref}:any)=>({data:{name:ref,commit:{sha:ref===branch?execution:ref==='main'?pin:base}}})),
   compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}})),
   getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:'1'.repeat(40)}]}}))},
  git:{getCommit:vi.fn(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}}))},
  actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),listWorkflowRuns:vi.fn(async()=>({data:{workflow_runs:[]}})),createWorkflowDispatch:vi.fn()}}};
 return{github,pull};
}
describe('manual PR refreshes validate candidate merges on the isolated execution commit',()=>{
 it.each(['linux','hosted-only'])('routes %s without making Main validate a stale PR merge; isolated validation still rejects it',async mode=>{
  const f=fixture(),value={...inputs,execution_mode:mode};
  await expect(routeManualCi(f.github,repo,pin,value,{pin,flag:'true'})).resolves.toEqual({routed:true,dispatched:true});
  expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
  expect(f.github.rest.actions.createWorkflowDispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({workflow_id:'ci.yml',ref:branch,inputs:value}));
  await expect(resolveRequestingSource(f.github,repo,{sha:execution,ref:`refs/heads/${branch}`,workflowRef:`${fullName}/.github/workflows/ci.yml@refs/heads/${branch}`,workflowSha:execution,controllerSha:pin},value)).rejects.toThrow('Merge commit parents do not bind the current PR head');
  expect(f.github.rest.repos.getCommit).toHaveBeenCalledWith(expect.objectContaining({ref:merge}));
 });
 it.each(['linux','hosted-only'])('preserves the complete exact %s tuple for isolated qualification',async mode=>{
  const f=fixture(),value={...inputs,execution_mode:mode};
  f.github.rest.repos.getCommit.mockResolvedValue({data:{sha:merge,parents:[{sha:base},{sha:head}]}});
  await routeManualCi(f.github,repo,pin,value,{pin,flag:'true'});
  const forwarded=f.github.rest.actions.createWorkflowDispatch.mock.calls[0][0].inputs;
  await expect(resolveRequestingSource(f.github,repo,{sha:execution,ref:`refs/heads/${branch}`,workflowRef:`${fullName}/.github/workflows/ci.yml@refs/heads/${branch}`,workflowSha:execution,controllerSha:pin},forwarded)).resolves.toMatchObject({prNumber:2781,headSha:head,baseSha:base,sourceSha:merge,mergeParents:[base,head],baseRef:'parent',headRef:'child',...(mode==='hosted-only'?{executionMode:mode}:{})});
 });
 it('keeps Linux label admission inside isolated source validation',async()=>{
  const f=fixture();f.pull.labels=[];
  await expect(routeManualCi(f.github,repo,pin,inputs,{pin,flag:'true'})).resolves.toMatchObject({routed:true,dispatched:true});
  await expect(resolveRequestingSource(f.github,repo,{sha:execution,ref:`refs/heads/${branch}`,workflowRef:`${fullName}/.github/workflows/ci.yml@refs/heads/${branch}`,workflowSha:execution,controllerSha:pin},inputs)).rejects.toThrow('Dedicated qualification revision or admission is stale');
 });
 it.each(['closed','draft','head','base'])('retains the cheap %s stale-request fence without dispatch',async kind=>{
  const f=fixture();
  if(kind==='closed')f.pull.state='closed';if(kind==='draft')f.pull.draft=true;
  if(kind==='head')f.pull.head.sha='9'.repeat(40);if(kind==='base')f.pull.base.sha='9'.repeat(40);
  await expect(routeManualCi(f.github,repo,pin,inputs,{pin,flag:'true'})).resolves.toEqual({routed:true,stale:true});
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['mode','number','head','base','source'])('rejects malformed routing %s before any dispatch',async kind=>{
  const f=fixture(),value={...inputs,execution_mode:'linux'};
  if(kind==='mode')value.execution_mode='anything';if(kind==='number')value.pr_number='02781';
  if(kind==='head')value.head_sha='bad';if(kind==='base')value.base_sha='bad';if(kind==='source')value.source_sha='bad';
  await expect(routeManualCi(f.github,repo,pin,value,{pin,flag:'true'})).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['number','head-repository','base-repository'])('rejects substituted PR %s before dispatch',async kind=>{
  const f=fixture();
  if(kind==='number')f.pull.number=2782;if(kind==='head-repository')f.pull.head.repo.full_name='foreign/repo';if(kind==='base-repository')f.pull.base.repo.full_name='foreign/repo';
  await expect(routeManualCi(f.github,repo,pin,inputs,{pin,flag:'true'})).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
 it.each(['tree','parent','branch','ancestry'])('does not route to an unverified isolated %s',async kind=>{
  const f=fixture();
  if(kind==='tree')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:commit_sha===execution?'9'.repeat(40):tree},parents:[{sha:pin}]}}));
  if(kind==='parent')f.github.rest.git.getCommit.mockImplementation(async({commit_sha}:any)=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:base}]}}));
  if(kind==='branch')f.github.rest.repos.getBranch.mockImplementation(async({branch:ref}:any)=>({data:{name:ref,commit:{sha:pin}}}));
  if(kind==='ancestry')f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({data:{status:'diverged',merge_base_commit:{sha:base}}});
  await expect(routeManualCi(f.github,repo,pin,inputs,{pin,flag:'true'})).rejects.toThrow();
  expect(f.github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
 });
});

it.each(['linux','hosted-only'])('the actual %s workflow authenticates origin and validates source before candidate checkout',mode=>{
 const steps=parse(readFileSync('.github/workflows/ci.yml','utf8')).jobs.changes.steps;
 const origin=steps.findIndex((step:any)=>step.id==='origin');
 const helpers=steps.findIndex((step:any)=>step.name==='Checkout trusted main refresh helpers');
 const source=steps.findIndex((step:any)=>step.id==='refresh');
 const checkout=steps.findIndex((step:any)=>step.name==='Checkout with bounded retry');
 expect(origin).toBeGreaterThanOrEqual(0);expect(helpers).toBeGreaterThan(origin);
 expect(source).toBeGreaterThan(helpers);expect(checkout).toBeGreaterThan(source);
 // Execute the real Actions JavaScript with the Node module loader. Only
 // GitHub transport and checkout execution are fixtures; rejection must stop
 // the job before any candidate checkout in both valid and invalid cases.
 const program=`
 import assert from 'node:assert/strict';import {createRequire} from 'node:module';
 const require=createRequire(import.meta.url),pin=${JSON.stringify(pin)},execution=${JSON.stringify(execution)},tree=${JSON.stringify(tree)},head=${JSON.stringify(head)},base=${JSON.stringify(base)},merge=${JSON.stringify(merge)},branch=${JSON.stringify(branch)};
 const context={repo:${JSON.stringify(repo)},ref:'refs/heads/'+branch,sha:execution,payload:{inputs:{...${JSON.stringify(inputs)},execution_mode:${JSON.stringify(mode)}}}};
 const workflowRef='HamedMP/matrix-os/.github/workflows/ci.yml@'+context.ref;
 Object.assign(process.env,{GITHUB_WORKSPACE:process.cwd(),CONTROLLER_SHA:pin,ISOLATED_EXECUTION:'true',EXECUTION_WORKFLOW_PATH:'.github/workflows/ci.yml',EXECUTION_WORKFLOW_REF:workflowRef,EXECUTION_WORKFLOW_SHA:execution,CI_WORKFLOW_REF:workflowRef,CI_WORKFLOW_SHA:execution});
 const pull={number:2781,state:'open',draft:false,head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'parent',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge,labels:[{name:'fast-ci'},{name:'ready-for-ci'}]};
 let valid=false;
 const github={rest:{pulls:{get:async()=>({data:pull})},repos:{getBranch:async({branch:ref})=>({data:{name:ref,commit:{sha:ref===branch?execution:ref==='main'?pin:base}}}),compareCommitsWithBasehead:async()=>({data:{status:'identical',merge_base_commit:{sha:pin}}}),getCommit:async()=>({data:{sha:merge,parents:[{sha:base},{sha:valid?head:'1'.repeat(40)}]}})},git:{getCommit:async({commit_sha})=>({data:{sha:commit_sha,tree:{sha:tree},parents:[{sha:pin}]}})}}};
 const selected=${JSON.stringify([steps[origin],steps[helpers],steps[source],steps[checkout]])};
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 for(const accepted of [false,true]){
  valid=accepted;const outputs={},events=[];
  const run=async()=>{for(const step of selected){
   const active=new Function('needs','github','inputs','return ('+step.if+');')({redirect:{outputs:{routed:''}}},{event_name:'workflow_dispatch'},context.payload.inputs);
   assert.equal(active,true);
   if(step.with?.script){await new AsyncFunction('github','context','core','require','process',step.with.script)(github,context,{setOutput:(k,v)=>{outputs[k]=v;}},require,process);events.push(step.id);}
   else if(step.name==='Checkout trusted main refresh helpers'){assert.equal(outputs.helper_sha,pin);events.push('trusted-helpers');}
   else{assert.equal(outputs.sourceSha,merge);assert.deepEqual(JSON.parse(outputs.snapshot).mergeParents,[base,head]);events.push('candidate-checkout');}
  }};
  if(accepted){await run();assert.deepEqual(events,['origin','trusted-helpers','refresh','candidate-checkout']);}
  else{await assert.rejects(run(),/Merge commit parents do not bind the current PR head/);assert.deepEqual(events,['origin','trusted-helpers']);assert.equal(outputs.sourceSha,undefined);}
 }
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:10000,maxBuffer:16384});
 expect(result.status,result.stderr).toBe(0);
});
