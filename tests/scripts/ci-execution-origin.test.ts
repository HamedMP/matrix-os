import {describe,expect,it,vi} from 'vitest';
import {executionBranch,executionControllerSha,verifyIsolatedExecutionOrigin,verifyIsolatedExecutionRun} from '../../scripts/ci/execution-origin.mjs';

const pin='a'.repeat(40),execution='b'.repeat(40),tree='c'.repeat(40),main='d'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'},workflowPath='.github/workflows/ci.yml';
const ref=`refs/heads/ci-execution/${pin}`;
function fixture(){
 const commits:any={
  [pin]:{sha:pin,tree:{sha:tree},parents:[{sha:'e'.repeat(40)}]},
  [execution]:{sha:execution,tree:{sha:tree},parents:[{sha:pin}]},
 };
 const github={rest:{git:{getCommit:vi.fn(async({commit_sha}:any)=>({data:commits[commit_sha]}))},repos:{
  getBranch:vi.fn(async({branch}:any)=>({data:{name:branch,commit:{sha:branch==='main'?main:execution}}})),
  compareCommitsWithBasehead:vi.fn(async()=>({data:{status:'ahead',merge_base_commit:{sha:pin}}})),
 }}};
 const context={ref,sha:execution,workflowRef:`HamedMP/matrix-os/${workflowPath}@${ref}`,workflowSha:execution};
 const run={id:123,run_attempt:1,workflow_id:98,path:workflowPath,event:'workflow_dispatch',head_sha:execution,head_branch:`ci-execution/${pin}`,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'}};
 const options={workflowPath,controllerSha:pin,workflowId:98};
 return{github,commits,context,run,options};
}
describe('isolated reviewed execution origin',()=>{
 it('uses a distinct execution ref and preserves the reviewed Main source authority',async()=>{
  const f=fixture();expect(executionBranch(pin)).toBe(`ci-execution/${pin}`);expect(executionControllerSha(ref)).toBe(pin);
  const proof=await verifyIsolatedExecutionOrigin(f.github,repo,f.context,f.options);
  expect(proof).toEqual({schemaVersion:1,controllerSha:pin,controllerRef:'refs/heads/main',executionRef:ref,executionSha:execution,executionWorkflowSha:execution,workflowPath,treeSha:tree});
  expect(f.context.ref).toBe(ref);expect(f.context.sha).toBe(execution);
  for(const args of [...f.github.rest.git.getCommit.mock.calls,...f.github.rest.repos.getBranch.mock.calls,...f.github.rest.repos.compareCommitsWithBasehead.mock.calls])expect(args[0].request.timeout).toBe(10000);
 });
 it('authenticates a completed historical execution from exact GitHub run metadata',async()=>{
  const f=fixture();expect(await verifyIsolatedExecutionRun(f.github,repo,{...f.run,status:'completed',conclusion:'success'},f.options)).toMatchObject({controllerSha:pin,executionSha:execution,executionRef:ref});
 });
 it.each(['same-sha','extra-parent','wrong-parent','changed-tree','untrusted-main','moved-ref','wrong-workflow','wrong-workflow-sha','wrong-pin','wrong-ref','malformed-tree'])('rejects %s without admitting an isolated origin',async kind=>{
  const f=fixture();
  if(kind==='same-sha'){f.context.sha=pin;f.context.workflowSha=pin;}
  if(kind==='extra-parent')f.commits[execution].parents.push({sha:main});
  if(kind==='wrong-parent')f.commits[execution].parents=[{sha:main}];
  if(kind==='changed-tree')f.commits[execution].tree.sha=main;
  if(kind==='untrusted-main')f.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({data:{status:'diverged',merge_base_commit:{sha:main}}});
  if(kind==='moved-ref')f.github.rest.repos.getBranch.mockImplementation(async({branch}:any)=>({data:{name:branch,commit:{sha:main}}}));
  if(kind==='wrong-workflow')f.context.workflowRef=`HamedMP/matrix-os/.github/workflows/other.yml@${ref}`;
  if(kind==='wrong-workflow-sha')f.context.workflowSha=main;
  if(kind==='wrong-pin')f.options.controllerSha=main;
  if(kind==='wrong-ref')f.context.ref='refs/heads/main';
  if(kind==='malformed-tree')f.commits[execution].tree.sha='main';
  await expect(verifyIsolatedExecutionOrigin(f.github,repo,f.context,f.options)).rejects.toThrow();
 });
 it.each(['main','fork','wrong-workflow','wrong-workflow-id','wrong-event','missing-attempt'])('rejects unauthenticated run metadata: %s',async kind=>{
  const f=fixture();
  if(kind==='main')f.run.head_branch='main';
  if(kind==='fork')f.run.head_repository.full_name='other/repo';
  if(kind==='wrong-workflow')f.run.path='.github/workflows/other.yml';
  if(kind==='wrong-workflow-id')f.run.workflow_id=99;
  if(kind==='wrong-event')f.run.event='pull_request';
  if(kind==='missing-attempt')f.run.run_attempt=0;
  await expect(verifyIsolatedExecutionRun(f.github,repo,f.run,f.options)).rejects.toThrow();
 });
 it('fails closed on a GitHub read failure rather than accepting a guessed tree',async()=>{
  const f=fixture();f.github.rest.git.getCommit.mockRejectedValue(new Error('unavailable'));
  await expect(verifyIsolatedExecutionOrigin(f.github,repo,f.context,f.options)).rejects.toThrow();
 });
 it('requires exact full isolated refs and lowercase commit identifiers',()=>{
  for(const invalid of ['main',`ci-execution/${pin}`,ref+'/',ref.replace(pin,pin.toUpperCase()),ref+'x'])expect(executionControllerSha(invalid)).toBeNull();
  expect(()=>executionBranch('main')).toThrow();
 });
});
