import {describe,expect,it,vi} from 'vitest';
import {routeManualCi} from '../../scripts/ci/dedicated-execution-router.mjs';
import {resolveRequestingSource} from '../../scripts/ci/dedicated-refresh.mjs';

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
