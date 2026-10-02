import { describe, it, expect, vi } from "vitest";
import { createSlackBridgeRoutes } from "../../packages/gateway/src/startup/slack-bridge.js";
import { signSlackBridgeRequest } from "../../packages/contracts/src/slack-bridge.js";
import {Hono} from "hono";
import {authMiddleware} from "../../packages/gateway/src/auth.js";

const token = "a".repeat(64);
const ownerId = "user_host";
const scopeId = "b8205675-a985-462c-a1be-5167adb5f6aa";
const now = () => new Date("2026-09-30T10:00:00Z");
function setup(publication?: (input: unknown) => Promise<boolean>) {
  const receive = vi.fn().mockResolvedValue(undefined);
  const authorize = vi.fn().mockImplementation(async ({scopeId,actorId,action}) => ({scopeId,actorId,ownerId,
    organizationId: "org_company", resourceKind: "project", resourceId: "project_company", role:"owner", capability:action}));
  const app = createSlackBridgeRoutes({ownerId,token,receive,authority:{authorize},now,authorizePublication:publication});
  return {app,receive,authorize};
}
async function request(path: string, data: unknown, secret = token) {
  const body = JSON.stringify(data);
  return {method:"POST",body,headers:{"content-type":"application/json",
    ...await signSlackBridgeRequest({token:secret,path,body,now:now()})}};
}
describe("owner Slack bridge", () => {
  it("accepts bridge signatures through global gateway auth without accepting anonymous events",async()=>{
    const {app:bridge}=setup();const app=new Hono();app.use("*",authMiddleware("owner-session-secret"));app.route("/",bridge);
    const payload={ownerId,organizationId:"org_company",actorId:ownerId,scopeId,action:"manage_members"};
    expect((await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",payload))).status).toBe(200);
    expect((await app.request("/api/internal/slack/authorize",{method:"POST",body:JSON.stringify(payload)})).status).toBe(401);
  });
  it("keeps public readiness and authenticated non-Slack routes outside the bridge signature/body limits", async () => {
    vi.stubEnv("MATRIX_USER_ID", ownerId);
    vi.stubEnv("MATRIX_HANDLE", "pr-2079");
    try {
      const { app: bridge } = setup();
      const app = new Hono();
      app.use("*", authMiddleware("owner-session-secret"));
      app.route("/", bridge); // production registers health and several owner APIs afterward
      app.get("/health", c => c.json({ status: "ok" }));
      app.get("/api/owner/settings", c => c.json({ available: true }));
      app.post("/api/owner/content", async c => c.json({ length: (await c.req.text()).length }));
      expect((await app.request("/health")).status).toBe(200);
      expect((await app.request("/api/owner/settings")).status).toBe(401);
      expect((await app.request("/api/owner/settings", { headers: { authorization: "Bearer owner-session-secret" } })).status).toBe(200);
      expect((await app.request("/api/owner/content", { method: "POST", headers: { authorization: "Bearer owner-session-secret" }, body: "x".repeat(300_000) })).status).toBe(200);
      expect((await app.request("/api/internal/slack/events")).status).toBe(401);
    } finally { vi.unstubAllEnvs(); }
  });
  it("requires a fresh signature over the exact path and body before dispatch", async () => {
    const {app,receive}=setup();
    const envelope={ownerId,organizationId:"org_company",actorId:"user_employee",channelScopeId:scopeId,
      event:{eventId:"Ev123",appId:"A123",teamId:"T123",userId:"U123",channelId:"C123",ts:"1759230000.123",text:"hello",kind:"mention"}};
    const init=await request("/api/internal/slack/events",envelope);
    expect((await app.request("/api/internal/slack/events",init)).status).toBe(202);
    expect(receive).toHaveBeenCalledWith(envelope);
    expect((await app.request("/api/internal/slack/events",{...init,body:JSON.stringify({...envelope,actorId:"user_attacker"})})).status).toBe(401);
    expect((await app.request("/api/internal/slack/events",await request("/api/internal/slack/events",envelope,"b".repeat(64)))).status).toBe(401);
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it("rejects owner substitution, missing signature, oversized input and expired signatures",async()=>{
    const {app,receive}=setup();
    const body=JSON.stringify({ownerId:"user_other"});
    expect((await app.request("/api/internal/slack/events",await request("/api/internal/slack/events",{ownerId:"user_other"}))).status).toBe(400);
    expect((await app.request("/api/internal/slack/events",{method:"POST",body})).status).toBe(401);
    const old=await signSlackBridgeRequest({token,path:"/api/internal/slack/events",body,now:new Date(now().getTime()-60_000)});
    expect((await app.request("/api/internal/slack/events",{method:"POST",body,headers:old})).status).toBe(401);
    expect((await app.request("/api/internal/slack/events",{method:"POST",body:"x".repeat(300_000)})).status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });
  it("requires contributor discussion authority for final Slack publication, refusing a downgraded viewer",async()=>{
    const {app,authorize}=setup();
    const data={ownerId,organizationId:"org_company",actorId:"user_employee",scopeId,action:"discuss"};
    authorize.mockResolvedValue({...data,capability:"discuss",resourceKind:"project",resourceId:"project_company",role:"editor"});
    expect(await (await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:true});
    expect(authorize).toHaveBeenCalledWith({scopeId,actorId:"user_employee",action:"discuss"});
    authorize.mockResolvedValue({...data,capability:"discuss",resourceKind:"project",resourceId:"project_company",role:"viewer"});
    expect(await (await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:false});
  });
  it("validates live project owner authority for channel binding",async()=>{
    const {app,authorize}=setup();
    const data={ownerId,organizationId:"org_company",actorId:ownerId,scopeId,action:"manage_members"};
    expect(await (await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:true});
    authorize.mockResolvedValue({...data,resourceKind:"chat",resourceId:"chat_1",role:"owner"});
    expect(await (await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:false});
  });
  it("requires a receipt-bound publication verifier after fresh contributor discussion authority",async()=>{
    const publication=vi.fn().mockResolvedValue(true);
    const {app,authorize}=setup(publication);
    const data={ownerId,organizationId:"org_company",actorId:"user_employee",scopeId,action:"publish_reply",appId:"A123",teamId:"T123",eventId:"Ev123",textDigest:"d".repeat(64)};
    expect(await(await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:true});
    expect(authorize).toHaveBeenCalledWith({scopeId,actorId:"user_employee",action:"discuss"});
    expect(publication).toHaveBeenCalledWith({organizationId:"org_company",actorId:"user_employee",scopeId,appId:"A123",teamId:"T123",eventId:"Ev123",textDigest:"d".repeat(64)});
    publication.mockResolvedValueOnce(false);
    expect(await(await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:false});
    const {app:missing}=setup();
    expect(await(await missing.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:false});
    authorize.mockResolvedValueOnce({...data,capability:"discuss",resourceKind:"project",resourceId:"project_company",role:"viewer"});
    expect(await(await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).json()).toEqual({allowed:false});
    expect(publication).toHaveBeenCalledTimes(2);
  });
  it.each([{textDigest:"wrong"},{eventId:"not_an_event"},{appId:"B123"},{teamId:"wrong"},{scopeId:"bad"},{actorId:"other"},{eventId:undefined},{sourceProofs:[]}])("rejects malformed or caller-supplied publication proofs %o",async(change)=>{
    const publication=vi.fn().mockResolvedValue(true);const {app}=setup(publication);
    const data={ownerId,organizationId:"org_company",actorId:"user_employee",scopeId,action:"publish_reply",appId:"A123",teamId:"T123",eventId:"Ev123",textDigest:"d".repeat(64),...change};
    expect((await app.request("/api/internal/slack/authorize",await request("/api/internal/slack/authorize",data))).status).toBe(400);
    expect(publication).not.toHaveBeenCalled();
  });

});
