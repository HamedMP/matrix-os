import {describe,expect,it,vi} from 'vitest';
import * as helpers from '../../scripts/ci/dedicated-admission.mjs';
const head='a'.repeat(40),oldBase='b'.repeat(40),base='c'.repeat(40),merge='d'.repeat(40),controller='e'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'};
const origin={sha:controller,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
function fixture(){
 const pull={number:2454,state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'ci-linux'}],head:{sha:head,ref:'child',repo:{full_name:'HamedMP/matrix-os'}},base:{sha:base,ref:'stack/parent',repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge};
 const summary={schemaVersion:2,suite:'qualification',headSha:head,baseSha:oldBase,baseRef:'stack/parent',sourceSha:oldBase,prNumber:2454,controllerSha:controller,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',controllerAttempt:1};
 const check={id:10,name:'Dedicated CI Results',head_sha:head,status:'completed',conclusion:'success',app:{slug:'github-actions'},details_url:'https://github.com/HamedMP/matrix-os/actions/runs/123',output:{summary:JSON.stringify(summary)}};
 const run={id:123,workflow_id:99,event:'pull_request_target',path:'.github/workflows/ci-dedicated.yml',head_sha:head,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const github={rest:{git:{getRef:vi.fn(async()=>({data:{object:{sha:base}}}))},pulls:{get:vi.fn(async()=>({data:pull})),list:vi.fn(async()=>({data:[pull]}))},checks:{listForRef:vi.fn(async()=>({data:{check_runs:[check]}})),update:vi.fn(async()=>({data:{}})),create:vi.fn(async()=>({data:{id:11}}))},actions:{getWorkflow:vi.fn(async()=>({data:{id:99,path:'.github/workflows/ci-dedicated.yml'}})),getWorkflowRun:vi.fn(async()=>({data:run}))}}};
 return{pull,summary,check,run,github};
}
async function reconcile(github:unknown){const fn=(helpers as Record<string,unknown>).reconcileDedicatedChildren as Function;expect(fn).toBeTypeOf('function');return fn(github,repo,origin,{serverUrl:'https://github.com'});}
describe('trusted parent-only stack invalidation',()=>{
 it('revokes the required dedicated child context without impersonating hosted CI Results',async()=>{
  const {github}=fixture();await reconcile(github);
  expect(github.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({check_run_id:10,status:'completed',conclusion:'failure'}));
  expect(github.rest.checks.create).not.toHaveBeenCalled();
 });
 it('leaves current completed evidence and unrelated checks untouched',async()=>{
  const {github,check,summary,pull}=fixture();check.output.summary=JSON.stringify({...summary,baseSha:pull.base.sha,sourceSha:pull.merge_commit_sha});
  await reconcile(github);expect(github.rest.checks.update).not.toHaveBeenCalled();expect(github.rest.checks.create).not.toHaveBeenCalled();
 });
 it.each(['app','workflow','repository','head','summary'])('never mutates unauthenticated %s check',async kind=>{
  const {github,check,run}=fixture();if(kind==='app')check.app.slug='attacker';if(kind==='workflow')run.workflow_id=100;if(kind==='repository')run.repository.full_name='other/repo';if(kind==='head')run.head_sha=base;if(kind==='summary')check.output.summary='{}';
  await reconcile(github);expect(github.rest.checks.update).not.toHaveBeenCalled();expect(github.rest.checks.create).not.toHaveBeenCalled();
 });
 it('rechecks child head before invalidation and never places a gate on an obsolete head',async()=>{
  const {github,pull}=fixture();github.rest.pulls.get.mockResolvedValue({data:{...pull,head:{...pull.head,sha:base}}});
  await reconcile(github);expect(github.rest.checks.create).not.toHaveBeenCalled();
 });
 it('rejects nonmain executable origin before any API request',async()=>{
  const {github}=fixture();const fn=(helpers as Record<string,unknown>).reconcileDedicatedChildren as Function;expect(fn).toBeTypeOf('function');
  await expect(fn(github,repo,{...origin,ref:'refs/heads/stack/parent'},{serverUrl:'https://github.com'})).rejects.toThrow(/default.branch/);expect(github.rest.pulls.list).not.toHaveBeenCalled();
 });
 it('propagates API denial and bounds list pagination',async()=>{
  const {github}=fixture();github.rest.pulls.list.mockRejectedValue(new Error('API denied'));await expect(reconcile(github)).rejects.toThrow('API denied');
 });
});

it('revokes current green evidence when only the live parent ref has advanced',async()=>{
 const f=fixture();f.check.output.summary=JSON.stringify({...f.summary,baseSha:f.pull.base.sha,sourceSha:f.pull.merge_commit_sha});
 f.github.rest.git.getRef.mockResolvedValue({data:{object:{sha:oldBase}}});await reconcile(f.github);
 expect(f.github.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({check_run_id:10,conclusion:'failure'}));
});
