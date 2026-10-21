import {describe,expect,it,vi} from 'vitest';
import {resolveMainSource} from '../../scripts/ci/dedicated-main.mjs';
import {readCurrentBranchSha} from '../../scripts/ci/dedicated-branch.mjs';
import {createConditionalGithub} from '../../scripts/ci/dedicated-api.mjs';
const source='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40);
const repo={owner:'HamedMP',repo:'matrix-os'};
function fixture(){
 const gitRef=vi.fn(async()=>({status:200,headers:{'x-poll-interval':'300'},data:{object:{sha:source}}}));
 const getBranch=vi.fn(async({branch}:any)=>({status:200,headers:{},data:{name:branch,commit:{sha:source}}}));
 const getCommit=vi.fn(async()=>({status:200,headers:{},data:{sha:source,parents:[{sha:base}],commit:{tree:{sha:tree}}}}));
 const api=createConditionalGithub({rest:{git:{getRef:gitRef},repos:{getBranch,getCommit}}},{authenticationContext:'branch-regression'});
 return{github:api.github,getBranch,gitRef,getCommit};
}
describe('live branch source attestation with GitHub ref polling policy',()=>{
 it('uses the exact branch endpoint without weakening the Git refs poll cap',async()=>{
  const f=fixture();await expect(resolveMainSource(f.github,repo,source)).resolves.toMatchObject({sourceSha:source,baseSha:base,mergeParents:[base]});
  expect(f.getBranch).toHaveBeenCalledTimes(2);expect(f.gitRef).not.toHaveBeenCalled();
  expect(f.getBranch).toHaveBeenCalledWith(expect.objectContaining({...repo,branch:'main',request:expect.objectContaining({timeout:10000,signal:expect.any(AbortSignal)})}));
  await expect(f.github.rest.git.getRef({...repo,ref:'heads/main'})).rejects.toThrow(/poll interval/);
 });
 it('rejects a branch renamed during the read despite an unchanged SHA',async()=>{
  const f=fixture();f.getBranch.mockResolvedValue({status:200,headers:{},data:{name:'renamed',commit:{sha:source}}});
  await expect(resolveMainSource(f.github,repo,source)).rejects.toThrow(/branch|ref/);
 });
 it('rejects a branch move between the exact commit proof and final read',async()=>{
  const f=fixture();f.getBranch.mockResolvedValueOnce({status:200,headers:{},data:{name:'main',commit:{sha:source}}}).mockResolvedValueOnce({status:200,headers:{},data:{name:'main',commit:{sha:base}}});
  await expect(resolveMainSource(f.github,repo,source)).rejects.toThrow(/stale|moved/);
 });
});

it.each(['','../main','main\\escape','main*','main?','main\n','main..x','main@{x','main/','main.'])('rejects invalid exact branch name %j before API access',async branch=>{
 const f=fixture();await expect(readCurrentBranchSha(f.github,repo,branch)).rejects.toThrow(/Invalid live branch/);expect(f.getBranch).not.toHaveBeenCalled();
});
it('propagates branch API denial without retaining cached source proof',async()=>{
 const f=fixture();f.getBranch.mockRejectedValue(new Error('API denied'));await expect(resolveMainSource(f.github,repo,source)).rejects.toThrow('API denied');
});

it('rejects malformed branch source SHAs without reaching exact commit proof',async()=>{
 const f=fixture();f.getBranch.mockResolvedValue({status:200,headers:{},data:{name:'main',commit:{sha:'not-a-sha'}}});await expect(resolveMainSource(f.github,repo,source)).rejects.toThrow(/Invalid live branch/);expect(f.getCommit).not.toHaveBeenCalled();
});
