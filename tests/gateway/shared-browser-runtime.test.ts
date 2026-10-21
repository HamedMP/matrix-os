import { describe,expect,it,vi } from "vitest";
import { createSharedBrowserRuntime } from "../../packages/gateway/src/shared-browser/runtime.js";

const driver=()=>({execute:vi.fn(),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})});
describe("shared browser production composition",()=>{
  it("requires installed service enablement and consistent owner projections",()=>{
    for(const options of [{enabled:false,ownerId:"owner",clerkOwnerId:"owner"},{enabled:true,ownerId:"owner",clerkOwnerId:"foreign"},{enabled:true,ownerId:undefined,clerkOwnerId:undefined}])
      expect(createSharedBrowserRuntime({homePath:"/tmp/fixture",...options,driver:driver()})).toBeUndefined();
  });
  it("verifies the fixed native input gate before admitting the first page action",async()=>{
    const d=driver();d.execute.mockResolvedValue({success:true,observationId:"obs",content:"invoices"});
    const fetcher=vi.fn(async(_url:unknown,init:RequestInit)=>Response.json({humanControlAvailable:JSON.parse(String(init.body)).enabled}));
    const runtime=createSharedBrowserRuntime({homePath:"/tmp/fixture",enabled:true,ownerId:"owner",clerkOwnerId:"owner",driver:d,fetcher})!;
    const binding={ownerId:"owner",chatId:"chat",runId:"run",harness:"pi" as const};const signal=new AbortController().signal;runtime.broker.openRun(binding,signal);
    await runtime.broker.execute(binding,{action:"snapshot"},signal);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8730/automation-input",expect.objectContaining({method:"POST",redirect:"error",signal:expect.any(AbortSignal),body:'{"enabled":false}'}));
    await runtime.close();expect(d.detach).toHaveBeenCalledOnce();
  });
  it("fails closed on a false acknowledgement or unexpected private response field",async()=>{
    for(const response of [{humanControlAvailable:true},{humanControlAvailable:false,privateTitle:"never disclose"}]){
      const d=driver();const runtime=createSharedBrowserRuntime({homePath:"/tmp/fixture",enabled:true,ownerId:"owner",clerkOwnerId:"owner",driver:d,fetcher:vi.fn(async()=>Response.json(response))})!;
      const binding={ownerId:"owner",chatId:"chat",runId:"run",harness:"pi" as const};const signal=new AbortController().signal;runtime.broker.openRun(binding,signal);
      await expect(runtime.broker.execute(binding,{action:"snapshot"},signal)).rejects.toHaveProperty("code","browser_unavailable");expect(d.execute).not.toHaveBeenCalled();await runtime.close();
    }
  });
});
