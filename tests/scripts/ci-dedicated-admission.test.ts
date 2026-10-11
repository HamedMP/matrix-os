import {describe,expect,it,vi} from 'vitest';
import {admitDedicatedSource,verifyCurrentDedicatedSource,selectDedicatedRoute} from '../../scripts/ci/dedicated-admission.mjs';
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40),controller='d'.repeat(40),moved='e'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'};
function fixture(baseRef='main') {
 const pull={number:2440,state:'open',draft:false,labels:[{name:'ready-for-ci'},{name:'ci-linux'}],base:{ref:baseRef,sha:base,repo:{full_name:'HamedMP/matrix-os'}},head:{sha:head,repo:{full_name:'HamedMP/matrix-os'}},merge_commit_sha:merge};
 const github={rest:{git:{getRef:vi.fn(async()=>({data:{object:{sha:base}}}))},pulls:{get:vi.fn(async()=>({data:pull}))},repos:{getCommit:vi.fn(async()=>({data:{sha:merge,parents:[{sha:base},{sha:head}]}}))}}};
 const input={repo,controller:{sha:controller,ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'},eventName:'pull_request_target',payload:{action:'synchronize',pull_request:structuredClone(pull)},inputSha:''};
 return{pull,github,input};
}
describe('trusted default controller admits exact stacked merge candidates',()=>{
 it.each(['main','stack/parent','codex/parent','release/other','feature/arbitrary-parent'])('accepts same-repo base %s',async ref=>{
  const {github,input}=fixture(ref);const value=await admitDedicatedSource(github,input);
  expect(value).toEqual({sourceSha:merge,headSha:head,baseSha:base,baseRef:ref,prNumber:2440});
  expect(github.rest.repos.getCommit).toHaveBeenCalledWith(expect.objectContaining({ref:merge,request:{timeout:10000}}));
 });
 it.each(['refs/heads/stack/parent','refs/heads/codex/parent','refs/pull/2440/merge'])('rejects controller ref %s before API access',async ref=>{
  const {github,input}=fixture('stack/parent');input.controller.ref=ref;
  await expect(admitDedicatedSource(github,input)).rejects.toThrow(/default.branch/);
  expect(github.rest.pulls.get).not.toHaveBeenCalled();
 });
 it('rejects helper origin from an untrusted parent workflow',async()=>{
  const {github,input}=fixture();input.controller.workflowRef=input.controller.workflowRef.replace('@refs/heads/main','@refs/heads/stack/parent');
  await expect(admitDedicatedSource(github,input)).rejects.toThrow(/default.branch/);
 });
 it.each(['head','base','ref'])('rejects a changed live %s snapshot',async field=>{
  const {github,input,pull}=fixture('stack/parent');
  if(field==='head')pull.head.sha=moved;
  if(field==='base')pull.base.sha=moved;
  if(field==='ref')pull.base.ref='codex/new-parent';
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
  expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
 });
 it.each(['head','base'])('rejects a foreign %s repository',async field=>{
  const {github,input,pull}=fixture();pull[field as 'head'|'base'].repo.full_name='other/matrix-os';
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
 });
 it.each(['closed','draft','unlabeled'])('rejects %s admission',async state=>{
  const {github,input,pull}=fixture();
  if(state==='closed')pull.state='closed';if(state==='draft')pull.draft=true;if(state==='unlabeled')pull.labels=[];
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
 });
 it.each(['unlabeled','converted_to_draft','closed'])('does not dispatch lifecycle invalidation %s',async action=>{
  const {github,input}=fixture();input.payload.action=action;
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
 });
 it('ignores title edits but admits base retarget edits and reopening',async()=>{
  const {github,input}=fixture('release/parent');input.payload.action='edited';
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
  Object.assign(input.payload,{changes:{base:{ref:{from:'main'}}}});
  await expect(admitDedicatedSource(github,input)).resolves.toMatchObject({baseRef:'release/parent'});
  input.payload.action='reopened';await expect(admitDedicatedSource(github,input)).resolves.toMatchObject({sourceSha:merge});
 });
 it('rejects unavailable, incorrect and reversed merge parent order',async()=>{
  const {github,input,pull}=fixture();pull.merge_commit_sha='';
  await expect(admitDedicatedSource(github,input)).rejects.toThrow(/merge commit/);
  pull.merge_commit_sha=merge;github.rest.repos.getCommit.mockResolvedValue({data:{sha:merge,parents:[{sha:head},{sha:moved}]}});
  await expect(admitDedicatedSource(github,input)).rejects.toThrow(/Merge commit/);
  github.rest.repos.getCommit.mockResolvedValue({data:{sha:merge,parents:[{sha:head},{sha:base}]}});
  await expect(admitDedicatedSource(github,input)).rejects.toThrow(/Merge commit/);
 });
 it('propagates admission API failures without treating them as ineligible',async()=>{
  const {github,input}=fixture();github.rest.pulls.get.mockRejectedValue(new Error('API unavailable'));
  await expect(admitDedicatedSource(github,input)).rejects.toThrow('API unavailable');
 });
 it('revalidates head/base/ref/merge, ready gate and repository before dispatch and settlement',async()=>{
  for(const change of ['head','base','ref','merge','label','draft','closed','repo']){
   const {github,input,pull}=fixture('stack/parent');const admitted=await admitDedicatedSource(github,input);
   if(change==='head')pull.head.sha=moved;if(change==='base')pull.base.sha=moved;if(change==='ref')pull.base.ref='another';if(change==='merge')pull.merge_commit_sha=moved;
   if(change==='label')pull.labels=[];if(change==='draft')pull.draft=true;if(change==='closed')pull.state='closed';if(change==='repo')pull.base.repo.full_name='other/repo';
   await expect(verifyCurrentDedicatedSource(github,repo,admitted)).rejects.toThrow(/stale|admission/);
  }
 });
 it('preserves exact-SHA manual benchmarking without reading a PR or certifying PR evidence',async()=>{
  const {github,input}=fixture();input.eventName='workflow_dispatch';input.inputSha=merge;
  const value=await admitDedicatedSource(github,input);
  expect(value).toEqual({sourceSha:merge,headSha:merge,baseSha:'',baseRef:'',prNumber:0});
  expect(github.rest.pulls.get).not.toHaveBeenCalled();
  await verifyCurrentDedicatedSource(github,repo,value);
  expect(github.rest.pulls.get).not.toHaveBeenCalled();
 });
 it('rejects a nonexact manual input before consulting the commit API',async()=>{
  const {github,input}=fixture();input.eventName='workflow_dispatch';input.inputSha='main';
  await expect(admitDedicatedSource(github,input)).rejects.toThrow('Exact commit SHA required');
  expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
 });
 it.each(['main','stack/parent','other/parent'])('routes only ready same-repo PRs with opt-in for base %s',ref=>{
  const {pull}=fixture(ref);const args={repository:'HamedMP/matrix-os',eventName:'pull_request',enabled:'true',shouldRun:'true',pull};
  expect(selectDedicatedRoute(args)).toBe(true);
  for(const patch of [{enabled:'false'},{shouldRun:'false'},{eventName:'merge_group'},{eventName:'push'},{eventName:'workflow_dispatch'}])expect(selectDedicatedRoute({...args,...patch})).toBe(false);
  pull.head.repo.full_name='other/repo';expect(selectDedicatedRoute(args)).toBe(false);
 });
});

describe('explicit Linux label admission',()=>{
 it.each(['ready-for-ci','ci-linux'])('requires %s before controller, routing and every live revalidation',async missing=>{
  const {github,input,pull}=fixture('stack/parent');const snapshot={sourceSha:merge,headSha:head,baseSha:base,baseRef:pull.base.ref,prNumber:pull.number};
  pull.labels=pull.labels.filter(label=>label.name!==missing);
  expect(selectDedicatedRoute({repository:'HamedMP/matrix-os',eventName:'pull_request',enabled:'true',shouldRun:'true',pull})).toBe(false);
  await expect(admitDedicatedSource(github,input)).resolves.toBeNull();
  await expect(verifyCurrentDedicatedSource(github,repo,snapshot)).rejects.toThrow(/stale|admission/);
  expect(github.rest.repos.getCommit).not.toHaveBeenCalled();
 });
});

it('rejects a moved parent ref even before the pull API refreshes its snapshot',async()=>{
 const {github,input}=fixture('stack/parent');github.rest.git.getRef.mockResolvedValue({data:{object:{sha:moved}}});
 await expect(admitDedicatedSource(github,input)).rejects.toThrow(/parent ref|base ref/);
 await expect(verifyCurrentDedicatedSource(github,repo,{prNumber:2440,headSha:head,baseSha:base,baseRef:'stack/parent',sourceSha:merge})).rejects.toThrow(/parent ref|base ref/);
});
