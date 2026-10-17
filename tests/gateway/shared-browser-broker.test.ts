import { describe, expect, it, vi } from "vitest";
import { createSharedBrowserBroker,SharedBrowserError } from "../../packages/gateway/src/shared-browser/broker.js";

const binding = { ownerId: "owner", chatId: "chat-1", runId: "run-1", harness: "pi" as const };
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
function setup() {
  const gates: boolean[]=[];
  const driver={ execute: vi.fn(async (_input:unknown,_signal:AbortSignal)=>({success:true,observationId:"obs-1",content:"Invoices"})), invalidateObservation:vi.fn(), detach:vi.fn(async()=>{}) };
  const broker=createSharedBrowserBroker({ ownerId:"owner", driver, setHumanControl:async(value:boolean)=>{gates.push(value);}, runTtlMs:60_000, drainTimeoutMs:100 });
  const controller=new AbortController(); const grant=broker.openRun(binding,controller.signal);
  return {broker,driver,gates,controller,grant};
}
describe("shared Chrome broker ownership and takeover",()=>{
  it("hands uncertain acknowledged mutations to the owner and refuses queued old observations",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    const entered=deferred<void>();const release=deferred<void>();
    s.driver.execute.mockImplementationOnce(async()=>{entered.resolve();await release.promise;throw new SharedBrowserError("browser_changed",true);});
    const first=s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"r1"},new AbortController().signal);
    const firstFailure=expect(first).rejects.toMatchObject({code:"browser_changed",dispatched:true});
    await entered.promise;
    const queued=s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"r1"},s.controller.signal).catch(error=>error);
    release.resolve();await firstFailure;
    expect((await queued).code).toBe("browser_changed");
    expect(s.broker.status()).toMatchObject({phase:"human",needsObservation:true});
    expect(s.driver.execute).toHaveBeenCalledTimes(2);expect(s.driver.detach).toHaveBeenCalledOnce();expect(s.gates).toEqual([false,true]);
    await s.broker.control("owner",{action:"resume"});
    await expect(s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"r1"},s.controller.signal)).rejects.toHaveProperty("code","observe_again");
    await s.broker.close();
  });
  it("marks an unknown browser transport result unavailable until explicit recovery",async()=>{
    const s=setup();s.driver.execute.mockRejectedValueOnce(new SharedBrowserError("browser_unavailable",true));
    await expect(s.broker.execute(binding,{action:"snapshot"},s.controller.signal)).rejects.toMatchObject({code:"browser_unavailable",dispatched:true});
    expect(s.broker.status().phase).toBe("unavailable");expect(s.gates).toEqual([false]);
    await s.broker.control("owner",{action:"stop"});expect(s.broker.status().phase).toBe("idle");await s.broker.close();
  });
  it("exports only verified downloads for the exact live run, preserving originals on export failure",async()=>{
    const artifact={documentId:"INV-1",path:"data/browser-artifacts/INV-1.pdf",size:800,sha256:"a".repeat(64),sourceUrl:"https://example.com/invoice.pdf",retrievedAt:new Date().toISOString(),original:true as const};
    const driver={execute:vi.fn(async()=>({success:true,observationId:"obs",content:"Invoices"} as import("@matrix-os/contracts").SharedBrowserActionResult)),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
    const exported=vi.fn(async()=>"data/browser-artifacts/collection.json");
    const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async()=>{},exportArtifacts:exported});
    const signal=new AbortController().signal;broker.openRun(binding,signal);await broker.execute(binding,{action:"snapshot"},signal);
    driver.execute.mockResolvedValueOnce({success:true,artifact});
    const result=await broker.execute(binding,{action:"download",documentId:"INV-1",ref:"r1",observationId:"obs"},signal);
    expect(result.collectionManifest).toBe("data/browser-artifacts/collection.json");expect(exported.mock.calls[0]?.[1]).toEqual([artifact]);
    expect(exported.mock.calls[0]?.[0]).toMatch(/^[a-f0-9-]{36}$/);
    await broker.execute(binding,{action:"snapshot"},signal);driver.execute.mockResolvedValueOnce({success:true,artifact});exported.mockRejectedValueOnce(new Error("private export detail"));
    const recovery=await broker.execute(binding,{action:"download",documentId:"INV-1",ref:"r1",observationId:"obs"},signal);
    expect(recovery).toMatchObject({success:false,artifact});expect(recovery.content).not.toContain("private export detail");expect(broker.status().phase).toBe("human");await broker.close();
  });
  it("hands control to the owner when the driver needs login or download recovery",async()=>{
    const s=setup();s.driver.execute.mockImplementationOnce(async()=>({success:false,content:"Owner sign-in required."}));
    const result=await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    expect(result.success).toBe(false);expect(s.broker.status().phase).toBe("human");
    expect(s.broker.status().needsObservation).toBe(true);expect(s.gates).toEqual([false,true]);
    expect(s.driver.detach).toHaveBeenCalledOnce();await s.broker.close();
  });
  it("finishes download recovery handoff before propagating action cancellation",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    const action=new AbortController();
    s.driver.execute.mockImplementationOnce(async()=>{
      action.abort();
      return{success:false,handoffRequested:true,content:"Owner review required."};
    });
    const recovery=s.broker.execute(binding,{action:"download",observationId:"obs-1",ref:"r1",documentId:"INV-1"},action.signal).catch(error=>error);
    const queued=s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"r1"},s.controller.signal).catch(error=>error);
    expect((await recovery).code).toBe("run_unavailable");
    expect((await queued).code).toBe("browser_changed");
    expect(s.broker.status()).toMatchObject({phase:"human",needsObservation:true});
    expect(s.driver.execute.mock.calls.map(call=>(call[0] as {action:string}).action)).toEqual(["snapshot","download"]);
    expect(s.driver.detach).toHaveBeenCalledOnce();expect(s.gates).toEqual([false,true]);await s.broker.close();
  });
  it("binds a native capability to one registered owner/chat/run",async()=>{
    const s=setup(); expect(s.broker.resolveCapability(s.grant.token)).toEqual(binding);
    expect(()=>s.broker.openRun({...binding,ownerId:"foreign",runId:"foreign"},new AbortController().signal)).toThrow();
    expect(s.broker.resolveCapability("forged")).toBeNull();
    await s.broker.close();
  });
  it("disables actual owner input before an agent action and restores it on close",async()=>{
    const s=setup(); s.driver.execute.mockImplementationOnce(async()=>{expect(s.gates).toEqual([false]);return{success:true,observationId:"obs-1",content:"Invoices"};});
    await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    expect(s.broker.status().phase).toBe("agent"); await s.broker.closeRun(binding.runId);
    expect(s.gates).toEqual([false,true]); expect(s.driver.detach).toHaveBeenCalledOnce();
    expect(s.broker.resolveCapability(s.grant.token)).toBeNull(); await s.broker.close();
  });
  it("drains an in-flight action before takeover and rejects its old queued successor",async()=>{
    const s=setup(); const started=deferred<void>();const completed=deferred<{success:boolean,observationId:string,content:string}>();
    s.driver.execute.mockImplementationOnce(async()=>{started.resolve();return completed.promise;});
    const first=s.broker.execute(binding,{action:"snapshot"},s.controller.signal);await started.promise;
    const queued=s.broker.execute(binding,{action:"snapshot"},s.controller.signal).catch(e=>e);
    const takeover=s.broker.control("owner",{action:"takeover"});
    expect(s.broker.status().phase).toBe("pausing"); expect(s.gates).toEqual([false]);
    completed.resolve({success:true,observationId:"old-obs",content:"Invoices"});await first;await takeover;
    expect(s.gates).toEqual([false,true]);expect(s.broker.status().phase).toBe("human");
    expect((await queued).code).toBe("browser_changed");expect(s.driver.execute).toHaveBeenCalledOnce();await s.broker.close();
  });
  it("requires a fresh observation after explicit owner resume",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    await s.broker.control("owner",{action:"takeover"});await s.broker.control("owner",{action:"resume"});
    await expect(s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"e1"},s.controller.signal)).rejects.toHaveProperty("code","observe_again");
    await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    expect(s.broker.status().needsObservation).toBe(false);await s.broker.close();
  });
  it("holds the live run while paused and does not replay its requested action on resume",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    await s.broker.control("owner",{action:"pause"});
    let settled=false;
    const pending=s.broker.execute(binding,{action:"click",observationId:"obs-1",ref:"e1"},s.controller.signal)
      .catch(error=>{settled=true;return error;});
    await Promise.resolve();expect(settled).toBe(false);expect(s.driver.execute).toHaveBeenCalledOnce();
    await s.broker.control("owner",{action:"resume"});expect((await pending).code).toBe("observe_again");
    expect(s.driver.execute).toHaveBeenCalledOnce();await s.broker.close();
  });
  it("does not let another Chat steal active Chrome control",async()=>{
    const s=setup(); const other={...binding,chatId:"chat-2",runId:"run-2",harness:"hermes" as const};const signal=new AbortController().signal;
    s.broker.openRun(other,signal);await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    await expect(s.broker.execute(other,{action:"snapshot"},signal)).rejects.toHaveProperty("code","browser_busy");await s.broker.close();
  });
  it("revokes cancelled native capabilities before any further page action",async()=>{
    const s=setup();s.controller.abort();expect(s.broker.resolveCapability(s.grant.token)).toBeNull();
    await expect(s.broker.execute(binding,{action:"snapshot"},s.controller.signal)).rejects.toHaveProperty("code","run_unavailable");
    expect(s.driver.execute).not.toHaveBeenCalled();await s.broker.close();
  });
  it("fails closed if the real viewer input gate cannot be disabled",async()=>{
    const driver={execute:vi.fn(),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
    const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async()=>{throw new Error("private failure");}});const signal=new AbortController().signal;broker.openRun(binding,signal);
    await expect(broker.execute(binding,{action:"snapshot"},signal)).rejects.toHaveProperty("code","browser_unavailable");
    expect(driver.execute).not.toHaveBeenCalled();expect(broker.status().phase).toBe("unavailable");await broker.close();
  });
  it("keeps owner input disabled if an in-flight action cannot be drained",async()=>{
    const s=setup();const started=deferred<void>(); const never=deferred<{success:boolean,observationId:string,content:string}>();
    s.driver.execute.mockImplementationOnce(async()=>{started.resolve();return never.promise;});
    const first=s.broker.execute(binding,{action:"snapshot"},s.controller.signal);await started.promise;
    await expect(s.broker.control("owner",{action:"takeover"})).rejects.toHaveProperty("code","browser_unavailable");
    expect(s.gates).toEqual([false]);expect(s.broker.status().phase).toBe("unavailable");
    never.resolve({success:true,observationId:"late",content:"late"});await first;await s.broker.close();
  });
  it("drains an agent claim still waiting for the input gate before acknowledging takeover",async()=>{
    const entered=deferred<void>();const release=deferred<void>();const gates:boolean[]=[];
    const driver={execute:vi.fn(),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
    const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async(enabled)=>{gates.push(enabled);if(!enabled){entered.resolve();await release.promise;}}});
    const signal=new AbortController().signal;broker.openRun(binding,signal);
    const action=broker.execute(binding,{action:"snapshot"},signal).catch(error=>error);await entered.promise;
    let acknowledged=false;const takeover=broker.control("owner",{action:"takeover"}).then(()=>{acknowledged=true;});
    await Promise.resolve();expect(acknowledged).toBe(false);expect(gates).toEqual([false]);
    release.resolve();expect((await action).code).toBe("browser_changed");await takeover;
    expect(driver.execute).not.toHaveBeenCalled();expect(gates).toEqual([false,true]);await broker.close();
  });
  it("serializes run cleanup after a delayed resume gate, without a stale idle acknowledgement",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);await s.broker.control("owner",{action:"takeover"});
    const entered=deferred<void>();const release=deferred<void>();
    const driver={execute:vi.fn(async()=>({success:true,observationId:"obs",content:"Invoices"})),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
    let enabled=true;let delayed=false;
    const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async(value)=>{if(!value && delayed){entered.resolve();await release.promise;}enabled=value;}});
    const signal=new AbortController().signal;broker.openRun(binding,signal);await broker.execute(binding,{action:"snapshot"},signal);await broker.control("owner",{action:"takeover"});delayed=true;
    const resume=broker.control("owner",{action:"resume"}).catch(error=>error);await entered.promise;
    let closed=false;const cleanup=broker.closeRun(binding.runId).then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
    release.resolve();expect((await resume).code).toBe("run_unavailable");await cleanup;
    expect(enabled).toBe(true);expect(broker.status().phase).toBe("idle");await broker.close();await s.broker.close();
  });
  it("does not release a paused snapshot when a newer takeover supersedes resume",async()=>{
    const entered=deferred<void>();const release=deferred<void>();let delayed=false;
    const driver={execute:vi.fn(async()=>({success:true,observationId:"obs",content:"Invoices"})),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
    const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async(value)=>{if(!value&&delayed){entered.resolve();await release.promise;}}});
    const controller=new AbortController();broker.openRun(binding,controller.signal);await broker.execute(binding,{action:"snapshot"},controller.signal);await broker.control("owner",{action:"takeover"});
    const waiting=broker.execute(binding,{action:"snapshot"},controller.signal).catch(error=>error);delayed=true;
    const resume=broker.control("owner",{action:"resume"}).catch(error=>error);await entered.promise;const takeover=broker.control("owner",{action:"takeover"});
    release.resolve();expect((await resume).code).toBe("browser_changed");await takeover;
    expect(driver.execute).toHaveBeenCalledOnce();await broker.close();expect((await waiting).code).toBe("run_unavailable");
  });
  it("rejects a new claim while an owner takeover from idle is still draining",async()=>{
    const s=setup();const entered=deferred<void>();const release=deferred<void>();
    s.driver.detach.mockImplementationOnce(async()=>{entered.resolve();await release.promise;});
    const takeover=s.broker.control("owner",{action:"takeover"});await entered.promise;
    const action=s.broker.execute(binding,{action:"snapshot"},s.controller.signal).catch(error=>error);
    expect((await action).code).toBe("browser_changed");expect(s.driver.execute).not.toHaveBeenCalled();release.resolve();await takeover;await s.broker.close();
  });
  it("normalizes detach failures and supports a deliberate stop retry",async()=>{
    const s=setup();await s.broker.execute(binding,{action:"snapshot"},s.controller.signal);
    s.driver.detach.mockRejectedValueOnce(new Error("private endpoint detail"));
    await expect(s.broker.control("owner",{action:"takeover"})).rejects.toHaveProperty("code","browser_unavailable");
    expect(s.broker.status().phase).toBe("unavailable");expect(s.gates).toEqual([false]);
    await s.broker.control("owner",{action:"stop"});expect(s.broker.status().phase).toBe("idle");expect(s.gates).toEqual([false,true]);await s.broker.close();
  });
  it("never rebinds an old queued action to replacement authority with reused identifiers",async()=>{
    const s=setup();const action=s.broker.execute(binding,{action:"snapshot"},s.controller.signal).catch(error=>error);
    const closed=s.broker.closeRun(binding.runId);s.broker.openRun(binding,new AbortController().signal);await closed;
    expect((await action).code).toBe("run_unavailable");expect(s.driver.execute).not.toHaveBeenCalled();await s.broker.close();
  });
  it("serializes owner window actions with first agent claims",async()=>{
    const s=setup();const entered=deferred<void>();const release=deferred<void>();
    const operation=s.broker.ownerOperation("owner",async()=>{entered.resolve();await release.promise;return"restored";});await entered.promise;
    await expect(s.broker.execute(binding,{action:"snapshot"},s.controller.signal)).rejects.toHaveProperty("code","browser_changed");
    release.resolve();expect(await operation).toBe("restored");await s.broker.close();
  });
});
