import { createHash, createHmac } from "node:crypto";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapSlackDatabase, type SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { SlackRepository, SlackRepositoryError } from "../../packages/platform/src/slack/repository.js";
import { createSlackAppRoutes, type SlackAppRouteOptions } from "../../packages/platform/src/slack/routes.js";
import { createRealCollaborationTestDatabase } from "../gateway/collaboration-test-support.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";

const clock = new Date("2026-09-30T10:00:00Z");
const config = { appId: "A123", clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32), tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://app.matrix-os.com" };
const org = "org_company";
let db: Kysely<SlackDatabase>;
let destroyFixture: () => Promise<void>;
let repo: SlackRepository;
let app: ReturnType<typeof createSlackAppRoutes>;
let actor: string | null;
let member: boolean;
let admin: boolean;
const dispatch = vi.fn();
const authorizeChannelBinding = vi.fn();
const authorizeReply = vi.fn();
const api = { exchangeCode: vi.fn(), postMessage: vi.fn(), replies: vi.fn(), history: vi.fn(), addReaction: vi.fn(), conversationInfo: vi.fn() };
function signed(payload: unknown) {
  return signedBody(JSON.stringify(payload));
}
function signedBody(body:string,timestamp=String(clock.getTime()/1000)) {
  return { method: "POST", body, headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` } };
}
function envelope(event: object, eventId = "Ev123") { return { type: "event_callback", api_app_id: config.appId, team_id: "T123", event_id: eventId, event }; }
const mention = { type: "app_mention", user: "U123", channel: "C123", text: "<@UBOT> summarize", ts: "123.456" };
function makeApp(overrides:Partial<SlackAppRouteOptions>={}) { return createSlackAppRoutes({ config, repository:repo, api, resolveActor:async()=>actor,
  requireOrgAdmin:async()=>admin,isCurrentMember:async()=>member,authorizeChannelBinding,authenticateRuntime:async()=>({ownerId:actor!}),authorizeReply,dispatch,now:()=>clock,...overrides }); }
const mutation=(path:string,method="POST",body:unknown={})=>app.request(path,{method,headers:{"content-type":"application/json",origin:config.publicBaseUrl},body:JSON.stringify(body)});
async function startOAuth(){const response=await mutation("/api/slack/install","POST",{organizationId:org});const url=new URL((await response.json()).url);return `/api/slack/oauth/callback?state=${url.searchParams.get("state")}&code=code`;}
async function linkEmployee(){await repo.createChallenge({hash:"f".repeat(64),appId:"A123",teamId:"T123",slackUserId:"U123"});await repo.completeLink({hash:"f".repeat(64),actorId:"user_employee",organizationId:org});}

beforeEach(async () => {
  if (process.env.MATRIX_TEST_POSTGRES_URL) {
    const fixture = await createRealCollaborationTestDatabase();
    db = fixture.db as unknown as Kysely<SlackDatabase>; destroyFixture = fixture.destroy;
  } else {
    const instance = await KyselyPGlite.create();
    db = new Kysely<SlackDatabase>({ dialect: instance.dialect }); destroyFixture = () => db.destroy();
  }
  await bootstrapSlackDatabase(db);
  repo = new SlackRepository(db, { now: () => clock });
  actor = "user_employee"; member = true; admin = true;
  vi.resetAllMocks();
  authorizeChannelBinding.mockResolvedValue(true);
  authorizeReply.mockImplementation(async ({ installation, destination, ownerId }) => {
    expect(installation).toMatchObject({ appId: "A123", teamId: "T123", state: "active" });
    expect(destination.ownerId).toBe(ownerId);
    return member;
  });
  api.conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true });
  api.replies.mockResolvedValue({ messages: [{ user: "U123", ts: "123.456", text: "original thread" }], hasMore: false });
  api.postMessage.mockResolvedValue({ ts: "123.999" });
  api.exchangeCode.mockResolvedValue({ appId: "A123", teamId: "T123", botUserId: "UBOT", botToken: "xoxb-secret" });
  dispatch.mockImplementation(async (input) => ({ ownerId: input.event.kind === "direct_message" ? "user_employee" : "user_admin" }));
  await repo.saveInstallation({ appId: "A123", teamId: "T123", organizationId: org, installedBy: "user_admin", botUserId: "UBOT", encryptedBotToken: encryptSlackToken("xoxb-secret", config.tokenEncryptionKey, "A123:T123") });
  app = makeApp();
});
afterEach(async () => { await app.shutdownSlack(); await destroyFixture(); });

describe("Slack app ingress", () => {
  it('hands a browser callback to session refresh without consuming its installation permit', async () => {
    const callback = await startOAuth(); actor = null;
    const response = await app.request(callback, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/slack/oauth/complete' + new URL(callback, config.publicBaseUrl).search);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(api.exchangeCode).not.toHaveBeenCalled();
    actor = 'user_employee';
    expect((await app.request(callback, { headers: { accept: 'application/json', authorization: 'Bearer refreshed-own-session' } })).status).toBe(200);
  });
  it('keeps invalid and non-browser callbacks unauthorized without forwarding credentials', async () => {
    const callback = await startOAuth(); actor = null;
    expect((await app.request(callback, { headers: { accept: 'application/json' } })).status).toBe(401);
    expect((await app.request('/api/slack/oauth/callback?state=invalid&code=invalid', { headers: { accept: 'text/html' } })).status).toBe(401);
    expect((await app.request(callback, { headers: { accept: 'text/html', authorization: 'Bearer invalid' } })).status).toBe(401);
    expect(api.exchangeCode).not.toHaveBeenCalled();
  });
  it("rejects unsafe callback origins and authenticates events using the live default clock",async()=>{
    for(const publicBaseUrl of ["http://app.matrix-os.com","https://user@app.matrix-os.com","https://app.matrix-os.com/path","https://app.matrix-os.com?bad=1","https://app.matrix-os.com#bad"])
      expect(()=>makeApp({config:{...config,publicBaseUrl}})).toThrow("Slack public origin unavailable");
    app=makeApp({now:undefined});expect((await app.request("/webhooks/slack/events",signedBody(JSON.stringify({type:"url_verification",challenge:"live"}),String(Math.floor(Date.now()/1000))))).status).toBe(200);
  });
  it("requires an account on every public management action and rejects malformed parameters",async()=>{
    const actions=[["/api/slack/install","POST"],["/api/slack/oauth/callback","GET"],["/api/slack/link/complete","POST"],["/api/slack/workspaces/T123/link","DELETE"],["/api/slack/workspaces/T123","DELETE"],["/api/slack/workspaces/T123/channels/C123","PUT"]];
    actor=null;for(const [path,method] of actions) expect((await (method==="GET"?app.request(path):mutation(path,method))).status).toBe(401);
    actor="user_employee";for(const [path,method] of [["/api/slack/install","POST"],["/api/slack/link/complete","POST"],["/api/slack/workspaces/invalid/link","DELETE"],["/api/slack/workspaces/invalid","DELETE"],["/api/slack/workspaces/T123/channels/D123","PUT"]]) expect((await mutation(path,method)).status).toBe(422);
    expect((await app.request("/api/slack/oauth/callback?state=bad&code=bad")).status).toBe(422);
    expect((await app.request("/api/slack/install",{method:"POST",headers:{origin:config.publicBaseUrl},body:"{"})).status).toBe(422);
  });
  it("checks fresh administrator and scope management authority before public mutations",async()=>{
    admin=false;expect((await mutation("/api/slack/install","POST",{organizationId:org})).status).toBe(403);
    expect((await mutation("/api/slack/workspaces/T123","DELETE")).status).toBe(403);
    const configure=()=>mutation("/api/slack/workspaces/T123/channels/C123","PUT",{scopeId:"11111111-1111-4111-8111-111111111111",approvedOutput:true});
    expect((await configure()).status).toBe(403);admin=true;authorizeChannelBinding.mockResolvedValueOnce(false);expect((await configure()).status).toBe(403);
    expect((await mutation("/api/slack/workspaces/T999","DELETE")).status).toBe(403);
    await repo.revokeInstallation("A123","T123");expect((await configure()).status).toBe(403);
  });
  it("lets an administrator cancel a reinstall after webhook revocation, including a callback in flight", async () => {
    await repo.revokeInstallation("A123", "T123");
    const callback = await startOAuth();
    api.exchangeCode.mockImplementationOnce(async () => {
      expect((await mutation("/api/slack/workspaces/T123", "DELETE")).status).toBe(204);
      return { appId: "A123", teamId: "T123", botUserId: "UBOT", botToken: "secret" };
    });
    expect((await app.request(callback)).status).toBe(409);
    expect(await repo.getInstallation("A123", "T123")).toMatchObject({ state: "revoked", generation: 3 });
  });
  it("allows another workspace's callback when an administrator removes a revoked workspace during exchange", async () => {
    await repo.revokeInstallation("A123", "T123");
    const callback = await startOAuth();
    api.exchangeCode.mockImplementationOnce(async () => {
      expect((await mutation("/api/slack/workspaces/T123", "DELETE")).status).toBe(204);
      return { appId: "A123", teamId: "T999", botUserId: "UBOT", botToken: "secret" };
    });
    expect((await app.request(callback)).status).toBe(200);
    expect(await repo.getInstallation("A123", "T999")).toMatchObject({ state: "active" });
  });
  it("retains pending reinstall permits when a nonadministrator requests removal", async () => {
    await repo.revokeInstallation("A123", "T123");
    const callback = await startOAuth();
    admin = false;
    expect((await mutation("/api/slack/workspaces/T123", "DELETE")).status).toBe(403);
    admin = true;
    expect((await app.request(callback)).status).toBe(200);
  });
  it("removes only the authenticated employee link",async()=>{
    await linkEmployee();actor="user_other";expect((await mutation("/api/slack/workspaces/T123/link","DELETE")).status).toBe(204);
    expect(await repo.getLink("A123","T123","U123")).not.toBeNull();actor="user_employee";expect((await mutation("/api/slack/workspaces/T123/link","DELETE")).status).toBe(204);expect(await repo.getLink("A123","T123","U123")).toBeNull();
  });
  it("rejects OAuth app substitution and privilege revocation while the provider responds",async()=>{
    let callback=await startOAuth();api.exchangeCode.mockResolvedValueOnce({appId:"A999",teamId:"T123",botUserId:"UBOT",botToken:"secret"});expect((await app.request(callback)).status).toBe(403);
    callback=await startOAuth();api.exchangeCode.mockImplementationOnce(async()=>{admin=false;return {appId:"A123",teamId:"T123",botUserId:"UBOT",botToken:"secret"};});expect((await app.request(callback)).status).toBe(403);
    expect((await repo.getInstallation("A123","T123"))?.generation).toBe(1);
  });
  it("returns bounded generic errors for raced OAuth consumption and database failures",async()=>{
    for(const error of [new SlackRepositoryError("capacity"),new SlackRepositoryError("forbidden"),new Error("private-database-path"),"private-database-path"]){
      const callback=await startOAuth();const spy=vi.spyOn(repo,"consumeOAuthState").mockRejectedValueOnce(error);const response=await app.request(callback);spy.mockRestore();
      expect(response.status).toBe(error instanceof SlackRepositoryError?(error.code==="capacity"?429:403):503);expect(await response.text()).not.toContain("private-database-path");
    }
  });
  it("denies expired installation links and handles consumption failures without linking",async()=>{
    const token="a".repeat(43),hash=createHash("sha256").update(token).digest("hex");await repo.createChallenge({hash,appId:"A123",teamId:"T123",slackUserId:"U123"});
    const finish=()=>mutation("/api/slack/link/complete","POST",{token});
    const spy=vi.spyOn(repo,"completeLink").mockRejectedValueOnce(new SlackRepositoryError("conflict"));expect((await finish()).status).toBe(409);spy.mockRestore();
    await repo.revokeInstallation("A123","T123");
    await db.insertInto("slack_link_challenges").values({hash,app_id:"A123",team_id:"T123",slack_user_id:"U123",expires_at:new Date(clock.getTime()+1000),consumed_at:null}).execute();
    expect((await finish()).status).toBe(403);
  });
  it("rejects malformed signed events and ignores external, bot and unsupported messages",async()=>{
    expect((await app.request("/webhooks/slack/events",signedBody("{"))).status).toBe(422);
    expect((await app.request("/webhooks/slack/events",signed({type:"invalid"}))).status).toBe(422);
    expect((await app.request("/webhooks/slack/events",signed({type:"url_verification",challenge:"c",api_app_id:"A999"}))).status).toBe(403);
    for(const event of [{...mention,is_ext_shared:true},{...mention,user_team:"T999"},{...mention,user_team:"T123",subtype:"message_changed"},{...mention,user:"UBOT"},{type:"reaction_added"}]) expect((await app.request("/webhooks/slack/events",signed(envelope(event)))).status).toBe(200);
    expect((await app.request("/webhooks/slack/events",signed({...envelope(mention),is_ext_shared_channel:true}))).status).toBe(200);
    for(const event of [{...mention,user:undefined},{...mention,channel:undefined},{...mention,ts:undefined},{...mention,channel:"D123"},{...mention,type:"message",channel_type:"im"}]) expect((await app.request("/webhooks/slack/events",signed(envelope(event)))).status).toBe(422);
    await repo.revokeInstallation("A123","T123");expect((await app.request("/webhooks/slack/events",signed(envelope(mention)))).status).toBe(403);expect(dispatch).not.toHaveBeenCalled();
  });
  it("normalizes an unexpected parser failure without revealing diagnostics",async()=>{
    for(const route of ["/api/slack/install","/webhooks/slack/events"])for(const error of [new Error("private-parser-path"),"private-parser-path"]){
      const spy=vi.spyOn(JSON,"parse").mockImplementationOnce(()=>{throw error;});
      const response=await app.request(route,route.startsWith("/api")?{method:"POST",headers:{origin:config.publicBaseUrl},body:"{}"}:signed({type:"invalid"}));spy.mockRestore();
      expect(response.status).toBe(422);expect(await response.text()).not.toContain("private-parser-path");
    }
  });
  it("contains body-reader failures at both public ingress boundaries",async()=>{
    for(const route of ["/api/slack/install","/webhooks/slack/events"]){
      const target=makeApp(),wrapper=new Hono();wrapper.use("*",async(c,next)=>{const fail=async()=>{throw Object.assign(new Error("reader unavailable"),{name:"BodyLimitError"});};if(route.startsWith("/api"))c.req.json=fail;else c.req.text=fail;await next();});wrapper.route("/",target);
      expect((await wrapper.request(route,route.startsWith("/api")?{method:"POST",headers:{origin:config.publicBaseUrl},body:"{}"}:signed(mention))).status).toBe(503);await target.shutdownSlack();
    }
    const spy=vi.spyOn(repo,"getInstallation").mockRejectedValueOnce("private-storage-path");const result=await app.request("/webhooks/slack/events",signed(envelope(mention)));spy.mockRestore();expect(result.status).toBe(503);expect(await result.text()).not.toContain("private-storage-path");
  });
  it("bounds simultaneous ingress while draining every retained operation",async()=>{
    let release!:()=>void;const gate=new Promise<null>(resolve=>{release=()=>resolve(null);});const spy=vi.spyOn(repo,"getInstallation").mockImplementation(()=>gate);
    const pending=Array.from({length:256},(_,index)=>app.request("/webhooks/slack/events",signed(envelope(mention,`EvCAP${index}`))));
    try {await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(256),{timeout:1000});expect((await app.request("/webhooks/slack/events",signed(envelope(mention,"EvOverflow")))).status).toBe(503);}
    finally{release();await Promise.all(pending);spy.mockRestore();}
  });
  it("returns retryable status on an active receipt, changed personal destination and unknown enqueue failure",async()=>{
    const request=signed(envelope(mention));await repo.claimEvent({appId:"A123",teamId:"T123",eventId:"Ev123"},createHash("sha256").update(request.body).digest("hex"));
    expect((await app.request("/webhooks/slack/events",request)).status).toBe(503);
    await linkEmployee();expect((await app.request("/webhooks/slack/events",signed(envelope(mention,"EvUnbound")))).status).toBe(200);const dm={...mention,type:"message",channel_type:"im",channel:"D123"};
    dispatch.mockResolvedValueOnce({ownerId:"user_other"});expect((await app.request("/webhooks/slack/events",signed(envelope(dm,"EvOther")))).status).toBe(503);
    dispatch.mockRejectedValueOnce("private-home-path");const failed=await app.request("/webhooks/slack/events",signed(envelope(dm,"EvUnknown")));expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("private-home-path");
    await app.shutdownSlack();expect((await app.request("/webhooks/slack/events",request)).status).toBe(503);
  });
  it("requires signature even for url verification and validates app/workspace", async () => {
    const payload = { type: "url_verification", challenge: "challenge", api_app_id: "A123" };
    expect((await app.request("/webhooks/slack/events", { method: "POST", body: JSON.stringify(payload) })).status).toBe(401);
    expect(await (await app.request("/webhooks/slack/events", signed(payload))).json()).toEqual({ challenge: "challenge" });
    expect((await app.request("/webhooks/slack/events", signed(envelope(mention, "EvNo")))).status).toBe(200); // Unmapped channel safely ignored.
    expect(dispatch).not.toHaveBeenCalled();
    expect((await app.request("/webhooks/slack/events", signed({ ...envelope(mention), api_app_id: "A999" }))).status).toBe(403);
  });
  it("queues linked scoped events durably before ack; retries dedup and reject digest changes", async () => {
    await repo.createChallenge({ hash: "a".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "a".repeat(64), actorId: "user_employee", organizationId: org });
    await repo.saveChannelBinding({ appId: "A123", teamId: "T123", organizationId: org, channelId: "C123", scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true, configuredBy: "user_admin" });
    const request = signed(envelope(mention));
    expect((await app.request("/webhooks/slack/events", request)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].event.text).toBe(mention.text);
    expect((await app.request("/webhooks/slack/events", request)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await app.request("/webhooks/slack/events", signed(envelope({ ...mention, text: "changed" })))).status).toBe(409);
    const rows = await db.selectFrom("slack_event_receipts").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain("summarize");
    expect(rows[0].state).toBe("completed");
  });
  it("returns retryable failure after a failed home enqueue, and never reacts to bots", async () => {
    await repo.createChallenge({ hash: "b".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "b".repeat(64), actorId: "user_employee", organizationId: org });
    const dm = { type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" };
    dispatch.mockRejectedValueOnce(new Error("private-path-secret"));
    const failed = await app.request("/webhooks/slack/events", signed(envelope(dm)));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private-path-secret");
    expect((await app.request("/webhooks/slack/events", signed(envelope(dm)))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((await app.request("/webhooks/slack/events", signed(envelope({ ...dm, bot_id: "B123" }, "EvBot")))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("binds links only to signed private-DM sender and authenticated current member", async () => {
    const dm = { type: "message", channel_type: "im", user: "U123", channel: "D123", text: "connect", ts: "123.456" };
    expect((await app.request("/webhooks/slack/events", signed(envelope(dm)))).status).toBe(200);
    const link = api.postMessage.mock.calls[0][0].text.match(/https:\/\/[^\s]+/)[0];
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();
    const complete = () => app.request("/api/slack/link/complete", { method: "POST", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ token }) });
    member = false; expect((await complete()).status).toBe(403);
    member = true; expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(409);
    expect((await repo.getLink("A123", "T123", "U123"))?.actorId).toBe(actor);
    expect((await app.request("/api/slack/link/complete", { method: "POST", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ token, slackUserId: "U999" }) })).status).toBe(422);
  });
  it("requires same-session fresh admin for single-use OAuth, pins redirect and encrypts token", async () => {
    const install = await app.request("/api/slack/install", { method: "POST", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ organizationId: org }) });
    const url = new URL((await install.json()).url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.matrix-os.com/api/slack/oauth/callback");
    const callback = `/api/slack/oauth/callback?state=${url.searchParams.get("state")}&code=code`;
    actor = "user_other"; expect((await app.request(callback)).status).toBe(403);
    actor = "user_employee"; admin = false; expect((await app.request(callback)).status).toBe(403);
    admin = true; expect((await app.request(callback)).status).toBe(200);
    expect((await app.request(callback)).status).toBe(409);
    expect((await repo.getInstallation("A123", "T123"))?.encryptedBotToken).not.toContain("xoxb-secret");
  });
  it.each([undefined,""," \n\t "])("acknowledges unsupported textless signed messages without home dispatch (%s)",async(text)=>{
    await repo.createChallenge({hash:"e".repeat(64),appId:"A123",teamId:"T123",slackUserId:"U123"});
    await repo.completeLink({hash:"e".repeat(64),actorId:"user_employee",organizationId:org});
    const request=signed(envelope({type:"message",channel_type:"im",user:"U123",channel:"D123",ts:"123.456",...(text===undefined?{}:{text})}));
    expect((await app.request("/webhooks/slack/events",request)).status).toBe(200);
    expect((await app.request("/webhooks/slack/events",request)).status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();expect(api.postMessage).not.toHaveBeenCalled();
  });
  it.each(["pending","exchanging"])("revokes %s OAuth installation permits and permits a new explicit reinstall",async(phase)=>{
    const begin=async()=>{
      const response=await app.request("/api/slack/install",{method:"POST",headers:{"content-type":"application/json",origin:config.publicBaseUrl},body:JSON.stringify({organizationId:org})});
      const url=new URL((await response.json()).url);return `/api/slack/oauth/callback?state=${url.searchParams.get("state")}&code=code`;
    };
    const callback=await begin();
    if(phase==="pending") expect((await app.request("/api/slack/workspaces/T123",{method:"DELETE",headers:{origin:config.publicBaseUrl}})).status).toBe(204);
    else api.exchangeCode.mockImplementationOnce(async()=>{
      expect((await app.request("/webhooks/slack/events",signed(envelope({type:"app_uninstalled"},"EvUninstall")))).status).toBe(200);
      return {appId:"A123",teamId:"T123",botUserId:"UBOT",botToken:"xoxb-stale"};
    });
    expect((await app.request(callback)).status).toBe(409);
    expect((await repo.getInstallation("A123","T123"))?.state).toBe("revoked");
    expect(api.exchangeCode).toHaveBeenCalledTimes(1); // target workspace is known only after exchange
    expect((await app.request(await begin())).status).toBe(200);
    expect((await repo.getInstallation("A123","T123"))?.state).toBe("active");
    expect((await app.request(callback)).status).toBe(409);
  });
  it("cancels an in-flight first installation on signed uninstall and deduplicates cancellation before a fresh retry",async()=>{
    await db.deleteFrom("slack_installations").execute();
    const begin=async()=>{
      const response=await app.request("/api/slack/install",{method:"POST",headers:{"content-type":"application/json",origin:config.publicBaseUrl},body:JSON.stringify({organizationId:org})});
      const url=new URL((await response.json()).url);return `/api/slack/oauth/callback?state=${url.searchParams.get("state")}&code=code`;
    };
    const uninstall=()=>app.request("/webhooks/slack/events",signed(envelope({type:"app_uninstalled"},"EvFirstUninstall")));
    const callback=await begin();
    api.exchangeCode.mockImplementationOnce(async()=>{
      expect((await uninstall()).status).toBe(200);return {appId:"A123",teamId:"T123",botUserId:"UBOT",botToken:"xoxb-stale"};
    });
    expect((await app.request(callback)).status).toBe(409);expect(await repo.getInstallation("A123","T123")).toBeNull();
    const fresh=await begin();expect((await uninstall()).status).toBe(200);
    expect((await app.request(fresh)).status).toBe(200);expect((await repo.getInstallation("A123","T123"))?.state).toBe("active");
  });
});


describe("Slack reply publication", () => {
  async function admitDm() {
    await repo.createChallenge({ hash: "d".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "d".repeat(64), actorId: "user_employee", organizationId: org });
    await app.request("/webhooks/slack/events", signed(envelope({ type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" })));
  }
  function reply(text = "response") { return app.request("/internal/slack/replies", { method: "POST", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ teamId: "T123", eventId: "Ev123", text }) }); }
  it("pins replies to admitted home, actor and original channel/thread, and deduplicates successful sends", async () => {
    await admitDm();
    actor = "user_admin"; expect((await reply()).status).toBe(403);
    actor = "user_employee"; expect((await reply()).status).toBe(200);
    expect(api.postMessage.mock.calls[0][0]).toMatchObject({ channelId: "D123", threadTs: "123.456", text: "response" });
    const replay = await reply();
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ sent: true, messageTs: "123.999" });
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect((await reply("different")).status).toBe(409);
  });

  it("passes the raw output digest and original receipt into both publication fences",async()=>{
    await admitDm();actor="user_employee";
    const text="Company answer: 語 and <@U123>";
    expect((await reply(text)).status).toBe(200);
    expect(authorizeReply).toHaveBeenCalledTimes(2);
    for(const [input] of authorizeReply.mock.calls) expect(input).toMatchObject({
      publication:{textDigest:createHash("sha256").update(text,"utf8").digest("hex")},
      destination:{appId:"A123",teamId:"T123",eventId:"Ev123",actorId:"user_employee",channelId:"D123",threadTs:"123.456"},
    });
  });
  it("fails closed on revocation and preserves unknown delivery without blindly resending", async () => {
    await admitDm(); actor = "user_employee";
    member = false; expect((await reply()).status).toBe(403); expect(api.postMessage).not.toHaveBeenCalled();
    member = true; api.postMessage.mockRejectedValueOnce(new Error("network lost after write"));
    expect((await reply()).status).toBe(503);
    expect((await reply()).status).toBe(409);
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("unknown");
  });
  it("rechecks current authority after channel metadata latency before publication", async () => {
    await admitDm();
    api.conversationInfo.mockImplementationOnce(async () => { member = false; return { isExternalShared: false, canAccess: true }; });
    expect((await reply()).status).toBe(403);
    expect(api.postMessage).not.toHaveBeenCalled();
  });
});


describe("Slack bounded ingress", () => {
  it("rejects oversized payloads before signature parsing", async () => {
    const response = await app.request("/webhooks/slack/events", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(256 * 1024 + 1) });
    expect(response.status).toBe(413); expect(dispatch).not.toHaveBeenCalled();
  });
  it("returns before Slack's acknowledgement window when destination admission stalls", async () => {
    await repo.createChallenge({ hash: "f".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "f".repeat(64), actorId: "user_employee", organizationId: org });
    dispatch.mockImplementationOnce(async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const started = performance.now();
    const response = await app.request("/webhooks/slack/events", signed(envelope({ type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" })));
    expect(response.status).toBe(503); expect(performance.now() - started).toBeLessThan(2_200);
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(true);
  });
});

describe("Slack account-only setup", () => {
  it("rejects cross-origin cookie mutations but permits exact-origin and authenticated bearer clients", async () => {
    const request = (headers: Record<string,string>) => app.request("/api/slack/install", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ organizationId: org }) });
    expect((await request({ origin: "https://attacker.example" })).status).toBe(403);
    expect((await request({})).status).toBe(403);
    expect((await request({ origin: config.publicBaseUrl })).status).toBe(200);
    expect((await request({ authorization: "Bearer authenticated-client-token" })).status).toBe(200);
    actor = null; expect((await request({ authorization: "Bearer unauthenticated" })).status).toBe(401);
  });
  it("offers account-only sign-in and a safe private completion page without querying a runtime", async () => {
    const token = "t".repeat(43);
    actor = null;
    const signedOut = await app.request(`/slack/link?token=${token}`);
    expect(signedOut.status).toBe(200); expect(await signedOut.text()).toContain("/sign-in?");
    expect(signedOut.headers.get("referrer-policy")).toBe("no-referrer");
    actor = "user_employee";
    const signedIn = await app.request(`/slack/link?token=${token}`);
    const page = await signedIn.text();
    expect(page).toContain("Connect your Slack account");
    expect(page).toContain("Your private messages stay between this Slack account and your Matrix account.");
    expect(page).toContain('aria-label="Matrix"');
    expect(page).toContain("@media(max-width:640px)");
    expect(page).toContain("Connect my Matrix");
    expect(signedIn.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect((await app.request("/slack/link?token=%3Cscript%3E")).status).toBe(422);
  });
});


describe("Slack scoped context and publication consent", () => {
  it("requires explicit channel output consent and denies externally shared channels", async () => {
    const request = (body: object) => app.request("/api/slack/workspaces/T123/channels/C123", { method: "PUT", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify(body) });
    const scopeId = "11111111-1111-4111-8111-111111111111";
    expect((await request({ scopeId })).status).toBe(422);
    api.conversationInfo.mockResolvedValueOnce({ isExternalShared: true, canAccess: true });
    expect((await request({ scopeId, approvedOutput: true })).status).toBe(403);
    expect((await request({ scopeId, approvedOutput: true })).status).toBe(200);
    expect((await repo.getChannelBinding("A123", "T123", "C123"))?.approvedOutput).toBe(true);
  });
  it("rechecks org administration after final home management authorization", async () => {
    authorizeChannelBinding.mockResolvedValueOnce(true).mockImplementationOnce(async () => { admin = false; return true; });
    const response = await app.request("/api/slack/workspaces/T123/channels/C123", { method: "PUT", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true }) });
    expect(response.status).toBe(403);
    expect(await repo.getChannelBinding("A123", "T123", "C123")).toBeNull();
  });
  it.each(["admin", "scope", "installation"])("denies channel configuration revoked during metadata loading: %s", async (reason) => {
    api.conversationInfo.mockImplementationOnce(async () => {
      if (reason === "admin") admin = false;
      if (reason === "scope") authorizeChannelBinding.mockResolvedValue(false);
      if (reason === "installation") await repo.saveInstallation({ appId: "A123", teamId: "T123", organizationId: org, installedBy: "user_admin", botUserId: "UBOT", encryptedBotToken: "replacement" });
      return { isExternalShared: false, canAccess: true };
    });
    const response = await app.request("/api/slack/workspaces/T123/channels/C123", { method: "PUT", headers: { "content-type": "application/json", origin: config.publicBaseUrl }, body: JSON.stringify({ scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true }) });
    expect(response.status).toBe(403);
    expect(await repo.getChannelBinding("A123", "T123", "C123")).toBeNull();
  });
  it("retrieves only the original thread for its admitted owner and marks content untrusted", async () => {
    await repo.createChallenge({ hash: "0".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "0".repeat(64), actorId: "user_employee", organizationId: org });
    await app.request("/webhooks/slack/events", signed(envelope({ type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" })));
    const request = () => app.request("/internal/slack/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId: "T123", eventId: "Ev123" }) });
    actor = "user_admin"; expect((await request()).status).toBe(403);
    actor = "user_employee";
    const result = await request(); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ available: true, untrusted: true, messages: [{ text: "original thread" }] });
    expect(api.replies.mock.calls[0][0]).toMatchObject({ channelId: "D123", ts: "123.456" });
    api.conversationInfo.mockResolvedValueOnce({ isExternalShared: true, canAccess: true });
    expect(await (await request()).json()).toMatchObject({ available: false, untrusted: true });
    api.replies.mockRejectedValueOnce(new Error("429 private provider detail"));
    const unavailable = await request(); expect(await unavailable.json()).toEqual({ available: false, untrusted: true });
    api.replies.mockImplementationOnce(async () => { member = false; return { messages: [{ ts: "123.456", text: "revoked thread" }], hasMore: false }; });
    const revoked = await request(); expect(revoked.status).toBe(403); expect(await revoked.text()).not.toContain("revoked thread");
  });
});

describe("Slack progress reaction", () => {
  async function admitThread() {
    await repo.createChallenge({ hash: "9".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "9".repeat(64), actorId: "user_employee", organizationId: org });
    await repo.saveChannelBinding({ appId: "A123", teamId: "T123", organizationId: org, channelId: "C123", scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true, configuredBy: "user_admin" });
    await app.request("/webhooks/slack/events", signed(envelope({ ...mention, thread_ts: "122.000" })));
    actor = "user_admin";
  }
  const react = (extra: object = {}) => app.request("/internal/slack/reactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId: "T123", eventId: "Ev123", ...extra }) });
  it("uses only the exact admitted owner's original message and fixed eyes, and deduplicates sent reactions", async () => {
    await admitThread();
    actor = null; expect((await react()).status).toBe(401);
    actor = "user_employee"; expect((await react()).status).toBe(403);
    actor = "user_admin";
    expect((await react({ channelId: "C999" })).status).toBe(422);
    expect((await react({ ts: "999.000" })).status).toBe(422);
    expect((await react({ name: "thumbsup" })).status).toBe(422);
    expect(await (await react()).json()).toEqual({ reacted: true });
    expect(api.addReaction.mock.calls[0][0]).toMatchObject({ channelId: "C123", ts: "123.456", name: "eyes" });
    expect(await (await react()).json()).toEqual({ reacted: true }); expect(api.addReaction).toHaveBeenCalledOnce();
  });
  it("checks revocation and external sharing after provider latency before reacting", async () => {
    await admitThread();
    member = false; expect((await react()).status).toBe(403);
    member = true; api.conversationInfo.mockResolvedValueOnce({ isExternalShared: true, canAccess: true });
    expect((await react()).status).toBe(403);
    api.conversationInfo.mockImplementationOnce(async () => { member = false; return { isExternalShared: false, canAccess: true }; });
    expect((await react()).status).toBe(403); expect(api.addReaction).not.toHaveBeenCalled();
  });
  it("retains uncertain outcome and permits safe retries of only the same exact reaction identity", async () => {
    await admitThread(); api.addReaction.mockRejectedValueOnce(new Error("lost after reaction"));
    expect((await react()).status).toBe(503);
    expect((await db.selectFrom("slack_reaction_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("unknown");
    expect(await (await react()).json()).toEqual({ reacted: true }); expect(api.addReaction).toHaveBeenCalledTimes(2);
    expect((await db.selectFrom("slack_reaction_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("sent");
  });
  it("applies the body bound before accepting a reaction payload", async () => {
    expect((await app.request("/internal/slack/reactions", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
    expect(api.addReaction).not.toHaveBeenCalled();
  });
});


describe("Slack authority RPC revocation fence", () => {
  it.each(["context", "replies", "reactions"].flatMap((operation) => ["link", "installation", "binding"].map((change) => ({ operation, change }))))("denies $operation when $change changes during final home authorization", async ({ operation, change }) => {
    await repo.createChallenge({ hash: "8".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repo.completeLink({ hash: "8".repeat(64), actorId: "user_employee", organizationId: org });
    const binding = { appId: "A123", teamId: "T123", organizationId: org, channelId: "C123", scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true, configuredBy: "user_admin" };
    await repo.saveChannelBinding(binding);
    await app.request("/webhooks/slack/events", signed(envelope(mention)));
    actor = "user_admin";
    authorizeReply.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      if (change === "link") await repo.removeLink("A123", "T123", "user_employee");
      if (change === "installation") await repo.revokeInstallation("A123", "T123");
      if (change === "binding") await repo.saveChannelBinding({ ...binding, scopeId: "22222222-2222-4222-8222-222222222222" });
      return true;
    });
    const response = await app.request(`/internal/slack/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId: "T123", eventId: "Ev123", ...(operation === "replies" ? { text: "company answer" } : {}) }) });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("original thread");
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(api.addReaction).not.toHaveBeenCalled();
  });
});
