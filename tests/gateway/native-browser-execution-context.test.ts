import { expect, it } from "vitest";
import { withNativeBrowserExecution, nativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
it("carries a transient trusted lease through delayed dispatch without leaking to parallel owners", async () => {
  let live=true; const run={isLive:()=>live, token:"synthetic", attemptId:"a"} as never;
  const one=withNativeBrowserExecution("owner",run,async()=>{ await new Promise(resolve=>setTimeout(resolve,1));expect(nativeBrowserExecution("owner")).toBe(run); expect(()=>nativeBrowserExecution("foreign")).toThrow("Browser run unavailable"); });
  expect(nativeBrowserExecution("owner")).toBeUndefined(); await one;
  live=false; expect(()=>withNativeBrowserExecution("owner",run,()=>nativeBrowserExecution("owner"))).toThrow("Browser run unavailable");
});
it("keeps distinct concurrent execution attempts isolated", async()=>{
  const a={isLive:()=>true,attemptId:"a"} as never;const b={isLive:()=>true,attemptId:"b"} as never;
  await Promise.all([withNativeBrowserExecution("owner",a,async()=>{await Promise.resolve();expect(nativeBrowserExecution("owner")).toBe(a);}),withNativeBrowserExecution("owner",b,async()=>{await Promise.resolve();expect(nativeBrowserExecution("owner")).toBe(b);})]);
  expect(nativeBrowserExecution("owner")).toBeUndefined();
});
it("explicitly clears inherited browser authority for an excluded nested run",()=>{
  const browser={isLive:()=>true} as never;
  withNativeBrowserExecution("owner",browser,()=>{
    expect(nativeBrowserExecution("owner")).toBe(browser);
    withNativeBrowserExecution("owner",undefined,()=>expect(nativeBrowserExecution("owner")).toBeUndefined());
    expect(nativeBrowserExecution("owner")).toBe(browser);
  });
});
