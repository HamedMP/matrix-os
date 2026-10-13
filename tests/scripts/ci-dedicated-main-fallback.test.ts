import {beforeEach,expect,it,vi} from 'vitest';
const wait=vi.hoisted(()=>vi.fn());
const resolveMain=vi.hoisted(()=>vi.fn());
vi.mock('../../scripts/ci/dedicated-result.mjs',()=>({waitForDedicatedResult:wait}));
vi.mock('../../scripts/ci/dedicated-main.mjs',()=>({resolveMainSource:resolveMain}));
const {decideCiBackend,decideRequestingBackend,MAIN_LINUX_ADMISSION_ATTEMPTS,MAIN_LINUX_BUDGET_MS}=await import('../../scripts/ci/dedicated-backend.mjs');
const main={sourceKind:'main',prNumber:0},pr={prNumber:2553};
beforeEach(()=>{wait.mockReset();resolveMain.mockReset();});

it('routes main to Linux when the bounded Linux run verifies',async()=>{
 wait.mockResolvedValue({runId:7,sourceSha:'a'});
 await expect(decideCiBackend({},main)).resolves.toEqual({provider:'linux',infrastructureFallback:false,controllerRunId:7});
 expect(wait).toHaveBeenCalledWith({},main,expect.objectContaining({allowInfrastructureFallback:true,admissionAttempts:MAIN_LINUX_ADMISSION_ATTEMPTS,maxMilliseconds:MAIN_LINUX_BUDGET_MS}));
});
it.each(['Verified dedicated Linux qualification failed','No Linux controller admitted within the admission window','Current main source is stale'])('falls main back to full hosted CI when %s',async message=>{
 wait.mockImplementation(async()=>{throw new Error(message);});
 await expect(decideCiBackend({},main)).resolves.toEqual({provider:'hosted',infrastructureFallback:true,controllerRunId:0,fallbackReason:message});
});
it('keeps fast-ci PRs strict: a Linux failure still fails the PR',async()=>{
 wait.mockImplementation(async()=>{throw new Error('Verified dedicated Linux qualification failed');});
 await expect(decideCiBackend({},pr)).rejects.toThrow('Verified dedicated Linux qualification failed');
 expect(wait.mock.calls[0][2]).not.toHaveProperty('admissionAttempts');
});
it('still selects hosted recovery for proven infrastructure failures',async()=>{
 wait.mockResolvedValue({runId:9,sourceSha:'a',infrastructure:{reason:'host-unavailable'}});
 await expect(decideCiBackend({},pr)).resolves.toEqual({provider:'hosted',infrastructureFallback:true,controllerRunId:9});
});

const push={eventName:'push',ref:'refs/heads/main',sha:'a'.repeat(40),repo:{owner:'HamedMP',repo:'matrix-os'}};
it('runs full hosted CI for a main commit that main already moved past before the backend step',async()=>{
 resolveMain.mockImplementation(async()=>{throw new Error('Current main source is stale');});
 await expect(decideRequestingBackend({},push,null,{requestingRunId:1})).resolves.toEqual({provider:'hosted',infrastructureFallback:true,controllerRunId:0,fallbackReason:'Current main source is stale'});
 expect(wait).not.toHaveBeenCalled();
});
it('passes the resolved main snapshot and requester identity to the bounded Linux wait',async()=>{
 resolveMain.mockResolvedValue({sourceKind:'main',prNumber:0,sourceSha:push.sha});wait.mockResolvedValue({runId:5,sourceSha:push.sha});
 await expect(decideRequestingBackend({},push,null,{requestingRunId:1,mode:'delegated'})).resolves.toMatchObject({provider:'linux',controllerRunId:5});
 expect(wait).toHaveBeenCalledWith({},expect.objectContaining({owner:'HamedMP',repo:'matrix-os',sourceKind:'main',sourceSha:push.sha,requestingRunId:1,mode:'delegated'}),expect.objectContaining({admissionAttempts:MAIN_LINUX_ADMISSION_ATTEMPTS}));
});
it('keeps PR snapshot errors fatal',async()=>{
 await expect(decideRequestingBackend({},{eventName:'pull_request',ref:'refs/pull/1/merge',payload:{},repo:push.repo},null,{})).rejects.toThrow('Unsupported dedicated requesting source');
});
