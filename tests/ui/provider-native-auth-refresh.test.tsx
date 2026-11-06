// @vitest-environment jsdom
import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ProviderSettingsSnapshotSchema,type ProviderSettingsSnapshot} from "@matrix-os/contracts";
import {useProviderSettingsController} from "../../packages/ui/src/agents-providers/provider-settings-controller.js";
import nativeInput from "../fixtures/claude-native-authenticated-off.json";
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime("2026-11-06T10:00:00Z");vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");vi.spyOn(navigator,"onLine","get").mockReturnValue(true);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
function snapshot(email="first@example.test",signedIn=true){
 const s=ProviderSettingsSnapshotSchema.parse(structuredClone(nativeInput));s.refreshedAt=new Date().toISOString();
 s.accounts[0]!.lastCheckedAt=s.refreshedAt;s.accounts[0]!.displayName=email;s.accounts[0]!.connectionDetails={email};s.accounts[0]!.authState=signedIn?"authenticated":"unknown";
 return s;
}
async function advance(ms=0){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}
it("discovers external Terminal login, account replacement and logout on focus without a Settings mutation or workflow",async()=>{
 let current=snapshot("first@example.test",false);const getSnapshot=vi.fn(async()=>structuredClone(current)),mutate=vi.fn(),onCatalogChanged=vi.fn();
 const transport={getSnapshot,mutate};
 const hook=renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,onCatalogChanged,automaticNativeAuthRefreshEnabled:true}));
 await advance();expect(hook.result.current.snapshot?.accounts[0]?.authState).toBe("unknown");
 current=snapshot();await advance(1000);await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(hook.result.current.snapshot?.accounts[0]?.authState).toBe("authenticated");
 expect(getSnapshot).toHaveBeenLastCalledWith(expect.any(AbortSignal),{refresh:false});
 expect(onCatalogChanged).toHaveBeenCalledOnce();
 current=snapshot("second@example.test");await advance(1000);await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(hook.result.current.snapshot?.accounts[0]?.connectionDetails?.email).toBe("second@example.test");
 current=snapshot("second@example.test",false);await advance(1000);await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(hook.result.current.snapshot?.accounts[0]?.authState).toBe("unknown");expect(onCatalogChanged).toHaveBeenCalledTimes(3);expect(mutate).not.toHaveBeenCalled();
});
it("bounds visible online polling and coalesces simultaneous focus events with an in-flight read",async()=>{
 let release:((s:ProviderSettingsSnapshot)=>void)|undefined;
 const getSnapshot=vi.fn(async()=>snapshot());const transport={getSnapshot,mutate:vi.fn()};
 renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));await advance();
 getSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 await advance(30_000);expect(getSnapshot).toHaveBeenCalledTimes(2);
 await act(async()=>{window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));});
 expect(getSnapshot).toHaveBeenCalledTimes(2);await act(async()=>release!(snapshot()));
 vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");await act(async()=>document.dispatchEvent(new Event("visibilitychange")));await advance(60_000);expect(getSnapshot).toHaveBeenCalledTimes(2);
 vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");vi.spyOn(navigator,"onLine","get").mockReturnValue(false);await act(async()=>window.dispatchEvent(new Event("focus")));await advance(60_000);expect(getSnapshot).toHaveBeenCalledTimes(2);
 vi.spyOn(navigator,"onLine","get").mockReturnValue(true);await act(async()=>window.dispatchEvent(new Event("online")));expect(getSnapshot).toHaveBeenCalledTimes(3);
});
it("keeps hidden Chat consumers idle and aborts the old Computer request on identity replacement",async()=>{
 let release:((s:ProviderSettingsSnapshot)=>void)|undefined;const oldSignals:AbortSignal[]=[];
 const oldTransport={getSnapshot:vi.fn(async(signal:AbortSignal)=>{oldSignals.push(signal);if(oldSignals.length===1)return snapshot();return new Promise<ProviderSettingsSnapshot>(resolve=>{release=resolve;});}),mutate:vi.fn()};
 const nextTransport={getSnapshot:vi.fn(async()=>snapshot("next@example.test")),mutate:vi.fn()};
 const hook=renderHook(({identityKey,transport,enabled})=>useProviderSettingsController({identityKey,transport,automaticNativeAuthRefreshEnabled:enabled}),{initialProps:{identityKey:"old",transport:oldTransport,enabled:true}});
 await advance();await advance(30_000);expect(oldSignals).toHaveLength(2);
 hook.rerender({identityKey:"next",transport:nextTransport,enabled:true});await advance();expect(oldSignals[1]?.aborted).toBe(true);
 await act(async()=>release!(snapshot("stale@example.test")));expect(hook.result.current.snapshot?.accounts[0]?.connectionDetails?.email).toBe("next@example.test");
 hook.rerender({identityKey:"next",transport:nextTransport,enabled:false});await advance(60_000);await act(async()=>window.dispatchEvent(new Event("focus")));expect(nextTransport.getSnapshot).toHaveBeenCalledOnce();
});
it("renews valid native evidence before its 30-second expiry despite ordinary response latency",async()=>{
 const getSnapshot=vi.fn(async()=>{
  const value=snapshot();
  await new Promise(resolve=>setTimeout(resolve,3000));
  return value;
 });
 const transport={getSnapshot,mutate:vi.fn()};
 const hook=renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));
 await advance(30_001);
 expect(getSnapshot.mock.calls.length).toBeGreaterThan(1);
 const checked=Date.parse(hook.result.current.snapshot!.accounts[0]!.lastCheckedAt!);
 expect(Date.now()-checked).toBeLessThan(30_000);
});
it("continues bounded native observation after correcting an initially fast wall clock",async()=>{
 const server=Date.parse("2026-11-06T10:00:00Z");vi.setSystemTime(server+3_600_000);
 const getSnapshot=vi.fn(async()=>snapshot());const transport={getSnapshot,mutate:vi.fn()};
 renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));
 await advance();expect(getSnapshot).toHaveBeenCalledOnce();
 vi.setSystemTime(server);
 await advance(20_000);expect(getSnapshot).toHaveBeenCalledTimes(2);
 await act(async()=>{window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));});
 expect(getSnapshot).toHaveBeenCalledTimes(2);
});

it("retains an early focus request until the remaining debounce expires",async()=>{
 let current=snapshot("first@example.test",false);
 const getSnapshot=vi.fn(async()=>structuredClone(current));const transport={getSnapshot,mutate:vi.fn()};
 const hook=renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));
 await advance();current=snapshot();
 await advance(100);await act(async()=>window.dispatchEvent(new Event("focus")));
 // Repeated focus/visibility events coalesce at the original 500ms boundary.
 await advance(100);await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
 await advance(299);expect(getSnapshot).toHaveBeenCalledOnce();
 await advance(1);expect(getSnapshot).toHaveBeenCalledTimes(2);
 expect(hook.result.current.snapshot?.accounts[0]?.authState).toBe("authenticated");
 await advance(19_999);expect(getSnapshot).toHaveBeenCalledTimes(2);
 await advance(1);expect(getSnapshot).toHaveBeenCalledTimes(3);
 expect(transport.mutate).not.toHaveBeenCalled();
});

it("retains focus after a recent native observation rather than postponing it to the cadence",async()=>{
 let current=snapshot("first@example.test",false);
 const getSnapshot=vi.fn(async()=>structuredClone(current));const transport={getSnapshot,mutate:vi.fn()};
 const hook=renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));
 await advance(1000);await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(getSnapshot).toHaveBeenCalledTimes(2);current=snapshot("replacement@example.test");
 await advance(100);await act(async()=>window.dispatchEvent(new Event("focus")));
 await advance(399);expect(getSnapshot).toHaveBeenCalledTimes(2);
 await advance(1);expect(getSnapshot).toHaveBeenCalledTimes(3);
 expect(hook.result.current.snapshot?.accounts[0]?.connectionDetails?.email).toBe("replacement@example.test");
});

it.each([200,700])("coalesces focus during a %dms native read into one bounded follow-up without overlap",async(responseDelay)=>{
 let current=snapshot("first@example.test",false);
 let release:((value:ProviderSettingsSnapshot)=>void)|undefined;
 const getSnapshot=vi.fn(async()=>structuredClone(current));const transport={getSnapshot,mutate:vi.fn()};
 const hook=renderHook(()=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:true}));
 await advance();
 getSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 await advance(1000);await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(getSnapshot).toHaveBeenCalledTimes(2);
 const oldObservation=structuredClone(current);current=snapshot("replacement@example.test");
 await advance(100);await act(async()=>{window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));});
 await advance(responseDelay-100);expect(getSnapshot).toHaveBeenCalledTimes(2);
 await act(async()=>release!(oldObservation));
 if(responseDelay<500){await advance(499-responseDelay);expect(getSnapshot).toHaveBeenCalledTimes(2);await advance(1);}else await advance();
 expect(getSnapshot).toHaveBeenCalledTimes(3);
 expect(hook.result.current.snapshot?.accounts[0]?.connectionDetails?.email).toBe("replacement@example.test");
 await advance(19_999);expect(getSnapshot).toHaveBeenCalledTimes(3);
});

it.each(["hidden","offline","disabled","disposed"] as const)("cleans up a trailing focus refresh when %s",async(mode)=>{
 const getSnapshot=vi.fn(async()=>snapshot());const transport={getSnapshot,mutate:vi.fn()};
 const hook=renderHook(({enabled})=>useProviderSettingsController({identityKey:"owner/main",transport,automaticNativeAuthRefreshEnabled:enabled}),{initialProps:{enabled:true}});
 await advance(100);await act(async()=>window.dispatchEvent(new Event("focus")));
 if(mode==="hidden"){
  vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
  await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
 }else if(mode==="offline"){
  vi.spyOn(navigator,"onLine","get").mockReturnValue(false);
  await act(async()=>window.dispatchEvent(new Event("offline")));
 }else if(mode==="disabled")hook.rerender({enabled:false});else hook.unmount();
 await advance(60_000);expect(getSnapshot).toHaveBeenCalledOnce();
});

it("cancels the old Computer's trailing focus timer on identity replacement",async()=>{
 const oldTransport={getSnapshot:vi.fn(async()=>snapshot("old@example.test")),mutate:vi.fn()};
 const nextTransport={getSnapshot:vi.fn(async()=>snapshot("next@example.test")),mutate:vi.fn()};
 const hook=renderHook(({identityKey,transport})=>useProviderSettingsController({identityKey,transport,automaticNativeAuthRefreshEnabled:true}),{initialProps:{identityKey:"old",transport:oldTransport}});
 await advance(100);await act(async()=>window.dispatchEvent(new Event("focus")));
 hook.rerender({identityKey:"next",transport:nextTransport});await advance(400);
 expect(oldTransport.getSnapshot).toHaveBeenCalledOnce();expect(nextTransport.getSnapshot).toHaveBeenCalledOnce();
 expect(hook.result.current.snapshot?.accounts[0]?.connectionDetails?.email).toBe("next@example.test");
});
