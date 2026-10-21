import {describe,expect,it,vi} from 'vitest';
import {verifyCurrentDedicatedSource,selectDedicatedRoute,admitDedicatedSource} from '../../scripts/ci/dedicated-admission.mjs';
import {authenticatedRequestingRun,authenticatedControllerRun} from '../../scripts/ci/dedicated-refresh.mjs';
import {validateLeaseRequest} from '../../scripts/ci/dedicated-ssh.mjs';
const source='a'.repeat(40),base='b'.repeat(40),second='c'.repeat(40),controller='d'.repeat(40),repo={owner:'HamedMP',repo:'matrix-os'};
function fixture(parents=[base]){
 const tuple={sourceKind:'main',prNumber:0,sourceSha:source,headSha:source,headRef:'main',baseSha:base,baseRef:'main',mergeParents:parents};
 const ci={id:321,run_attempt:1,event:'push',workflow_id:98,path:'.github/workflows/ci.yml',head_sha:source,head_branch:'main',display_title:`CI coverage-v1 · ${source}`,status:'in_progress',repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const run={...ci,id:123,workflow_id:99,event:'workflow_run',path:'.github/workflows/ci-dedicated.yml',display_title:`dedicated-refresh-v2 execution=true request=321 title=${ci.display_title}`};
 const github={rest:{repos:{getBranch:vi.fn(async(args:any)=>({data:{name:args.branch,commit:{sha:source}}})),getCommit:vi.fn(async()=>({data:{sha:source,parents:parents.map(sha=>({sha})),commit:{tree:{sha:second}}}}))},pulls:{get:vi.fn()},actions:{getWorkflow:vi.fn(async()=>({data:{id:98,path:'.github/workflows/ci.yml'}})),getWorkflowRun:vi.fn(async()=>({data:ci}))}}};
 return{tuple,ci,run,github};
}
describe('authenticated default private main CI',()=>{
 it.each([[[base]],[[base,second]]])('binds an actual public main commit with parents %j',async parents=>{
  const f=fixture(parents);await expect(verifyCurrentDedicatedSource(f.github,repo,f.tuple)).resolves.toMatchObject({mergeParents:parents});
  expect(f.github.rest.pulls.get).not.toHaveBeenCalled();
 });
 it.each(['tip','kind','parents','head','base','ref'])('rejects ambiguous or stale main %s',async field=>{
  const f=fixture();if(field==='tip')f.github.rest.repos.getBranch.mockImplementation(async(args:any)=>({data:{name:args.branch,commit:{sha:second}}}));if(field==='kind')delete(f.tuple as any).sourceKind;if(field==='parents')f.tuple.mergeParents=[second];if(field==='head')f.tuple.headSha=second;if(field==='base')f.tuple.baseSha=second;if(field==='ref')f.tuple.baseRef='other';
  await expect(verifyCurrentDedicatedSource(f.github,repo,f.tuple)).rejects.toThrow();
 });
 it('routes exact main push by enabled switch without PR labels',()=>{
  const args={repository:'HamedMP/matrix-os',eventName:'push',ref:'refs/heads/main',enabled:'true',shouldRun:'true'};
  expect(selectDedicatedRoute(args)).toBe(true);
  for(const patch of [{enabled:'false'},{ref:'refs/heads/other'},{eventName:'workflow_dispatch'},{repository:'other/repo'}])expect(selectDedicatedRoute({...args,...patch})).toBe(false);
 });
 it('authenticates main requester and execution controller with exact push provenance',()=>{
  const f=fixture(),scope={...f.tuple,requestingRunId:321};
  expect(authenticatedRequestingRun(f.ci,repo,scope,{id:98})).toBe(true);
  expect(authenticatedControllerRun(f.run,repo,scope,{id:99},'main')).toBe(true);
  for(const patch of [{event:'workflow_dispatch'},{head_branch:'other'},{head_sha:second},{head_repository:{full_name:'fork/repo'}}])expect(authenticatedRequestingRun({...f.ci,...patch},repo,scope,{id:98})).toBe(false);
 });
 it('admits main only through the exact authenticated current push workflow-run',async()=>{
  const f=fixture(),admit=(action:string)=>admitDedicatedSource(f.github,{repo,controller:{sha:controller,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'},eventName:'workflow_run',payload:{action,workflow_run:f.ci}});
  await expect(admit('requested')).resolves.toMatchObject(f.tuple);
  // Repeated in_progress events of a first attempt never start another main controller.
  await expect(admit('in_progress')).resolves.toBeNull();
 });
 it('requires explicit signed main kind and rejects pr0 legacy shape',()=>{
  const f=fixture(),value:any={repository:'HamedMP/matrix-os',sourceKind:'main',prNumber:0,headSha:source,baseSha:base,baseRef:'main',mergeSha:source,mergeParents:[base],requestingRunId:321,requestingRunAttempt:1,controllerRunId:123,controllerRunAttempt:1,controllerSha:controller,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'delegated',suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
  expect(validateLeaseRequest(value)).toEqual(value);delete value.sourceKind;expect(()=>validateLeaseRequest(value)).toThrow();
 });
});
it('bounds hung main API attestation without authorizing a stale grant',async()=>{
 const f=fixture();vi.useFakeTimers();f.github.rest.repos.getBranch.mockImplementation(()=>new Promise(()=>{}) as any);
 try{const pending=verifyCurrentDedicatedSource(f.github,repo,f.tuple);const rejected=expect(pending).rejects.toThrow(/deadline/);await vi.advanceTimersByTimeAsync(20001);await rejected;}finally{vi.useRealTimers();}
});
it('rejects an explicit main snapshot with a different head ref',async()=>{
 const f=fixture();f.tuple.headRef='feature/source';await expect(verifyCurrentDedicatedSource(f.github,repo,f.tuple)).rejects.toThrow();
});
