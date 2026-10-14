import { SHARED_BROWSER_ACTION_MAX_BYTES } from "../../packages/contracts/src/shared-browser.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAppSessionKey, signAppSession } from "../../packages/gateway/src/app-runtime/app-session.js";
import { registerBrowserLabRoutes } from "../../packages/gateway/src/browser-lab/routes.js";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(close=>close()));});
function setup() {
  const key=deriveAppSessionKey("shared-browser-route-owner-secret32","browser-lab");
  const cookie=`matrix_app_session__browser-lab=${signAppSession(key,{v:1,slug:"browser-lab",principal:"gateway-owner",scope:"personal",iat:1,exp:Math.floor(Date.now()/1000)+600})}`;
  let human=true;const driver={execute:vi.fn(async()=>({success:true,content:"Synthetic invoices",observationId:"obs"})),invalidateObservation:vi.fn(),detach:vi.fn(async()=>{})};
  const broker=createSharedBrowserBroker({ownerId:"owner",driver,setHumanControl:async(enabled)=>{human=enabled;}});
  const binding={ownerId:"owner",chatId:"chat-1",runId:"run-1",harness:"pi" as const};
  const controller=new AbortController();const grant=broker.openRun(binding,controller.signal);
  const app=new Hono();const fetcher=vi.fn(async()=>Response.json({available:true,chrome:{present:true,minimized:false},humanControlAvailable:human}));
  const lab=registerBrowserLabRoutes(app,{enabled:true,deriveKey:()=>key,isAllowedOrigin:origin=>origin==="https://app.matrix-os.com",fetcher,sharedBrowser:{broker,ownerId:"owner"}});
  cleanups.push(async()=>{lab.close();await broker.close();});
  const agent=(body:unknown,token=grant.token)=>app.request("/apps/browser-lab/api/agent-action",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
  const owner=(action:string,origin="https://app.matrix-os.com")=>app.request("/apps/browser-lab/api/browser-automation",{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify({action})});
  return{app,cookie,broker,binding,controller,grant,driver,fetcher,agent,owner};
}
describe("owner viewer and run-bound shared Chrome routes",()=>{
  it("allows only the exact live run capability on agent-action",async()=>{
    const s=setup();expect((await s.agent({action:"snapshot"},"forged")).status).toBe(401);
    expect((await s.app.request("/apps/browser-lab/api/agent-action",{method:"POST",headers:{cookie:s.cookie},body:'{"action":"snapshot"}'})).status).toBe(401);
    expect((await s.agent({action:"snapshot"})).status).toBe(200);expect(s.driver.execute).toHaveBeenCalledOnce();
    s.controller.abort();expect((await s.agent({action:"snapshot"})).status).toBe(401);
  });
  it("keeps watching read-only without implicitly taking over the agent",async()=>{
    const s=setup();await s.agent({action:"snapshot"});
    const status=await s.app.request("/apps/browser-lab/api/browser-status",{headers:{cookie:s.cookie}});
    expect(await status.json()).toMatchObject({humanControlAvailable:false,automation:{phase:"agent",run:{harness:"pi"}}});
    const viewer=await s.app.request("/apps/browser-lab/api/browser-session",{method:"POST",headers:{cookie:s.cookie,origin:"https://app.matrix-os.com"},body:'{"surface":"browser"}'});
    expect(viewer.status).toBe(200);expect(s.broker.status().phase).toBe("agent");
    expect(s.fetcher.mock.calls.some(call=>String(call[0]).endsWith("/browser-session"))).toBe(false);
    expect(s.fetcher.mock.calls.some(call=>String(call[0]).endsWith("/browser-observe"))).toBe(true);
  });
  it("owner takeover and resume keep Chrome and its current presentation",async()=>{
    const s=setup();await s.agent({action:"snapshot"});
    expect(await (await s.owner("takeover")).json()).toMatchObject({humanControlAvailable:true,automation:{phase:"human"}});
    expect(await (await s.owner("resume")).json()).toMatchObject({humanControlAvailable:false,automation:{phase:"agent",needsObservation:true}});
    expect(s.driver.detach).toHaveBeenCalledOnce();
    const refusal=await s.agent({action:"click",observationId:"obs",ref:"r1"});
    expect(refusal.status).toBe(200);expect(await refusal.json()).toMatchObject({success:false,automation:{needsObservation:true}});
  });
  it("does not admit caller-selected owner/run or broaden control origins",async()=>{
    const s=setup();expect((await s.agent({action:"snapshot",ownerId:"foreign"})).status).toBe(400);
    expect((await s.owner("takeover","https://foreign.test")).status).toBe(403);
    expect((await s.app.request("/apps/browser-lab/api/browser-automation",{method:"POST",body:'{"action":"takeover"}'})).status).toBe(401);
    expect(s.driver.execute).not.toHaveBeenCalled();
  });
  it.each(["中".repeat(4000), "\u0000".repeat(4000)])("accepts maximum schema-valid native text encoding",async(text)=>{
    const s=setup();await s.agent({action:"snapshot"});
    const action={action:"type",observationId:"o".repeat(128),ref:"r".repeat(128),text};
    expect(Buffer.byteLength(JSON.stringify(action))).toBeGreaterThan(8192);
    expect((await s.agent(action)).status).toBe(200);
    expect(s.driver.execute).toHaveBeenLastCalledWith(action,expect.any(AbortSignal));
  });
  it("rejects oversized control and agent bodies before decoding",async()=>{
    const s=setup();const body=JSON.stringify({action:"snapshot",padding:"x".repeat(SHARED_BROWSER_ACTION_MAX_BYTES)});
    for(const [path,headers] of [["agent-action",{authorization:`Bearer ${s.grant.token}`}],["browser-automation",{cookie:s.cookie}]] as const){
      expect((await s.app.request(`/apps/browser-lab/api/${path}`,{method:"POST",headers:{...headers,"content-type":"application/json"},body})).status).toBe(413);
    }
    expect(s.driver.execute).not.toHaveBeenCalled();
  });
});
