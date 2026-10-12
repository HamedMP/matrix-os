import {describe,expect,it,vi} from 'vitest';
import {resolveDedicatedMergeParents} from '../../scripts/ci/dedicated-merge.mjs';
import {nativeStackFixture,nativePins} from './helpers/native-stack-fixture';
const repo={owner:'HamedMP',repo:'matrix-os'};
describe('protected native cumulative merge proof',()=>{
 it('binds the public two-level tuple through official membership and readonly tree equivalence',async()=>{
  const f=nativeStackFixture();expect(await resolveDedicatedMergeParents(f.github,repo,f.pull)).toEqual(f.snapshot.mergeParents);
  expect(f.github.request).toHaveBeenCalledTimes(2);
  expect(f.github.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/stacks/{stack_number}',expect.objectContaining({stack_number:2492,request:expect.objectContaining({timeout:expect.any(Number),signal:expect.any(AbortSignal)})}));
 });
 it.each(['missing','id','number','size','position','baseRef','baseSha'])('rejects malformed child native metadata %s',async field=>{
  const f=nativeStackFixture();if(field==='missing')delete f.pull.stack;else if(field==='baseRef')f.pull.stack.base.ref='';else if(field==='baseSha')f.pull.stack.base.sha='';else f.pull.stack[field]=field==='size'?101:0;
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it.each(['closed','id','number','trunk','truncated','duplicate','foreignRow','head','ref','base','linkage','oversize'])('rejects incomplete or mismatched official stack %s',async field=>{
  const f=nativeStackFixture(),s=f.stack;
  if(field==='closed')s.open=false;if(field==='id')s.id++;if(field==='number')s.number++;if(field==='trunk')s.base.ref='other';if(field==='truncated')s.pull_requests.pop();if(field==='duplicate')s.pull_requests[0].number=s.pull_requests[1].number;
  if(field==='foreignRow')s.pull_requests[0].head.repo.id=1;
  if(field==='head')s.pull_requests[1].head.sha=nativePins.trunk;if(field==='ref')s.pull_requests[1].head.ref='other';if(field==='base')s.pull_requests[1].base.sha=nativePins.trunk;if(field==='linkage')s.pull_requests[0].head.sha=nativePins.trunk;if(field==='oversize')s.extra='x'.repeat(1024*1024);
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it.each(['closed','draft','fork','position','size','stackid','trunk','merge','head','ref','base','repoid'])('rejects changed live predecessor %s',async field=>{
  const f=nativeStackFixture(),p=f.parent;
  if(field==='closed')p.state='closed';if(field==='draft')p.draft=true;if(field==='fork')p.head.repo.full_name='other/repo';if(field==='repoid')p.head.repo.id=1;if(field==='position')p.stack.position=2;if(field==='size')p.stack.size=3;if(field==='stackid')p.stack.id++;if(field==='trunk')p.stack.base.sha=nativePins.head;if(field==='merge')p.merge_commit_sha=nativePins.trunk;if(field==='head')p.head.sha=nativePins.trunk;if(field==='ref')p.head.ref='other';if(field==='base')p.base.sha=nativePins.head;
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it.each(['one','three','swap','same','head','parentHead','parentTree','childTree','missingTree'])('rejects wrong actual commit parent/tree proof %s',async field=>{
  const f=nativeStackFixture(),child=f.commits[nativePins.merge],parent=f.commits[nativePins.parentMerge];
  if(field==='one')child.parents.pop();if(field==='three')child.parents.push({sha:nativePins.trunk});if(field==='swap')child.parents.reverse();if(field==='same')child.parents=[{sha:nativePins.head},{sha:nativePins.head}];if(field==='head')child.parents[1].sha=nativePins.base;if(field==='parentHead')parent.parents[1].sha=nativePins.head;if(field==='parentTree')parent.commit.tree.sha=nativePins.headTree;if(field==='childTree')child.commit.tree.sha=nativePins.baseTree;if(field==='missingTree')delete parent.commit.tree;
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it.each(['child','parent','membership','trunk','parentref','labels'])('rejects %s movement at the final reread',async field=>{
  const f=nativeStackFixture();let calls=0;
  const original=f.github.rest.repos.getCommit;
  f.github.rest.repos.getCommit=vi.fn(async(args:any)=>{
   const value=await original(args);
   if(++calls===4){
    if(field==='child')f.pull.merge_commit_sha=nativePins.head;if(field==='parent')f.parent.merge_commit_sha=nativePins.trunk;if(field==='membership')f.stack.pull_requests[1].head.ref='changed';if(field==='labels')f.pull.labels=[];
    if(['trunk','parentref'].includes(field))f.github.rest.git.getRef.mockImplementation(async(a:any)=>({data:{object:{sha:(field==='trunk'&&a.ref==='heads/main')||(field==='parentref'&&a.ref!=='heads/main')?nativePins.head:a.ref==='heads/main'?nativePins.trunk:nativePins.base}}}));
   }
   return value;
  });
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it.each(['unsupported','denied','malformed'])('fails closed on native API %s',async kind=>{
  const f=nativeStackFixture();if(kind==='unsupported')delete f.github.request;if(kind==='denied')f.github.request.mockRejectedValue(new Error('API denied'));if(kind==='malformed')f.github.request.mockResolvedValue({data:{}});
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();
 });
 it('does not treat tree equality or arbitrary synthetic ancestry as native membership',async()=>{
  const f=nativeStackFixture();delete f.pull.stack;
  await expect(resolveDedicatedMergeParents(f.github,repo,f.pull)).rejects.toThrow();expect(f.github.request).not.toHaveBeenCalled();
 });
 it('keeps ordinary exact branch/head merge semantics without native API access',async()=>{
  const f=nativeStackFixture();f.commits[nativePins.merge].parents[0].sha=nativePins.base;delete f.pull.stack;
  expect(await resolveDedicatedMergeParents(f.github,repo,f.pull)).toEqual([nativePins.base,nativePins.head]);expect(f.github.request).not.toHaveBeenCalled();
 });
 it('ignores unrelated repository timestamps and predecessor labels on final reread',async()=>{
  const f=nativeStackFixture();let calls=0;const original=f.github.rest.repos.getCommit;
  f.github.rest.repos.getCommit=vi.fn(async(args:any)=>{const value=await original(args);if(++calls===4){f.pull.head.repo.pushed_at='later';f.parent.labels=[{name:'unrelated'}];}return value;});
  expect(await resolveDedicatedMergeParents(f.github,repo,f.pull)).toEqual(f.snapshot.mergeParents);
 });
 it('bounds a stalled authenticated API independently of adapter timeout behavior',async()=>{
  vi.useFakeTimers();try{
   const f=nativeStackFixture();f.github.rest.repos.getCommit.mockImplementation(()=>new Promise(()=>{}));const pending=resolveDedicatedMergeParents(f.github,repo,f.pull);pending.catch(()=>{});
   await vi.advanceTimersByTimeAsync(10001);await expect(pending).rejects.toThrow(/deadline/);
  }finally{vi.useRealTimers();}
 });
});
