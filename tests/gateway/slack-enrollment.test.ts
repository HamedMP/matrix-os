import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "../../packages/platform/src/platform-token.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createEnrolledSlackReadSource } from "../../packages/gateway/src/slack/enrolled-read-source.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(scope: "channel" | "thread" = "channel") {
  const f = await createRealBotStateDatabase(); cleanup.push(f.destroy);
  const ownerId = "user_enrollment", botId = "bot_12345678", chatId = "chat_enrollment", runtimeId = "runtime_enrollment", handle = "pr-3482";
  const target = { ownerId, botId, chatId, runtimeId }, now = new Date();
  await insertChat(f.db, chatId, ownerId);
  await f.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: now, removed_at: null }).execute();
  const grant = { ...target, appId: "A123", teamId: "T123", channelId: "C123", organizationId: "org_enrollment", ownerSlackId: "U123", installationGeneration: 1, linkCreatedAt: now.toISOString(), scope, ...(scope === "thread" ? { threadTs: "1795000000.000001" } : {}) };
  const access = { ...target, grantId: createHash("sha256").update(JSON.stringify(grant)).digest("hex") };
  const state = { member: true, slackMember: true, canAccess: true, external: false, runtime: { ownerId, runtimeId } as {ownerId:string;runtimeId:string}|null, channel: { id: "C123", name: "tech" } };
  const token = buildPlatformVerificationToken(handle, "fixture-platform-secret");
  const config = { appId: "A123", clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32), tokenEncryptionKey: Buffer.alloc(32,42).toString("base64"), publicBaseUrl: "https://platform.example" };
  const api = { conversationInfo: vi.fn(async () => ({ canAccess: state.canAccess, isExternalShared: state.external, channelMetadata: state.channel })),
    hasChannelMember: vi.fn(async () => state.slackMember), history: vi.fn(), replies: vi.fn(), postMessage: vi.fn(), addReaction: vi.fn(), exchangeCode: vi.fn() };
  const platform = await createSlackApp({ db: f.db as unknown as Kysely<SlackDatabase>, config, api, contextGrant: grant, startCleanup: false,
    now: () => now, dispatch: vi.fn(), resolveActor: async () => null, requireOrgAdmin: async () => false, isCurrentMember: async () => state.member,
    authorizeChannelBinding: async () => false, resolveDestination: async () => ({ ownerId, runtimeId }),
    authenticateRuntime: async c => c.req.header("x-matrix-handle") === handle && timingSafeTokenEquals(c.req.header("authorization")?.replace(/^Bearer /,""), token) ? state.runtime : null });
  cleanup.push(platform.close);
  await platform.repository.saveInstallation({ appId: grant.appId, teamId: grant.teamId, organizationId: grant.organizationId, installedBy: ownerId, botUserId: "UBOT", encryptedBotToken: encryptSlackToken("xoxb-synthetic", config.tokenEncryptionKey, "A123:T123") });
  await platform.repository.createChallenge({ hash: "f".repeat(64), appId: grant.appId, teamId: grant.teamId, slackUserId: grant.ownerSlackId });
  await platform.repository.completeLink({ hash: "f".repeat(64), actorId: ownerId, organizationId: grant.organizationId });
  const path = "/internal/slack/thread-context/enrollment";
  const request = (input: unknown = target, bearer = token) => platform.routes.request(path, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "x-matrix-handle": handle } });
  const client = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, token, handle, fetchImpl: async (url, init) => platform.routes.fetch(new Request(url, init)) });
  const discovery = vi.fn(client.discoverThreadEnrollment);
  const context = await createPrivateSlackThreadContext({ db: f.db, ownerId, runtimeId, authorize: async () => ({ allowed: true, channel: state.channel }), discoverEnrollment: discovery } as Parameters<typeof createPrivateSlackThreadContext>[0]);
  const rows = async () => Number((await sql<{count:string}>`SELECT count(*) AS count FROM slack_private_thread_context`.execute(f.db)).rows[0]!.count);
  return { ...f, target, grant, access, state, api, platform, client, request, context, discovery, rows };
}
it("discovers the exact currently authorized source through runtime-HMAC Hono with zero context rows or side effects", async () => {
  const f = await fixture();
  expect(await f.rows()).toBe(0);
  const response = await f.request(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ available: true, access: f.access, appId: "A123", teamId: "T123", channelId: "C123", scope: "channel", channel: { id: "C123", name: "tech" } });
  expect(await f.context.enrollment({ ...f.target, signal: AbortSignal.timeout(5000) })).toEqual({ access: f.access, appId: "A123", teamId: "T123", scope: "channel", channel: { id: "C123", name: "tech" } });
  expect(await f.rows()).toBe(0); expect(await f.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
  expect(f.api.history).not.toHaveBeenCalled(); expect(f.api.replies).not.toHaveBeenCalled(); expect(f.api.postMessage).not.toHaveBeenCalled(); expect(f.api.addReaction).not.toHaveBeenCalled();
});
it("uses the configured discovery callback for empty-context native inventory", async () => {
  const f = await fixture();
  const source = createEnrolledSlackReadSource({ context: f.context, read: vi.fn() });
  const inventory = await source.inventory({ ...f.target, requestClass: "interactive" } as never, AbortSignal.timeout(5000));
  expect(inventory).toContain("#tech"); expect(inventory).toContain("slack_enrolled_"); expect(f.discovery).toHaveBeenCalledOnce(); expect(await f.rows()).toBe(0);
});
it("denies invalid runtime or target before provider reads and rejects selector/oversized requests", async () => {
  const f = await fixture();
  expect((await f.request(f.target, "b".repeat(64))).status).toBe(401);
  for (const patch of [{ownerId:"user_other"},{botId:"bot_87654321"},{chatId:"chat_other"},{runtimeId:"runtime_other"}]) {
    const response = await f.request({ ...f.target, ...patch }); expect(response.status).toBe(200); expect(await response.json()).toEqual({available:false});
  }
  expect((await f.request({...f.target, channelId:"C456"})).status).toBe(400);
  expect((await f.request({...f.target, padding:"x".repeat(5000)})).status).toBe(413);
  for (const runtime of [{ownerId:"user_other",runtimeId:f.target.runtimeId},{ownerId:f.target.ownerId,runtimeId:"runtime_other"}]) {
    f.state.runtime=runtime; expect(await (await f.request()).json()).toEqual({available:false});
  }
  f.state.runtime=null; expect((await f.request()).status).toBe(401);
  expect(f.api.conversationInfo).not.toHaveBeenCalled();
});

it.each(["organization", "slack-member", "app-access", "external", "wrong-channel", "invalid-name", "installation", "link"] as const)("denies discovery after %s authority loss", async kind => {
  const f = await fixture();
  if (kind === "organization") f.state.member = false;
  if (kind === "slack-member") f.state.slackMember = false;
  if (kind === "app-access") f.state.canAccess = false;
  if (kind === "external") f.state.external = true;
  if (kind === "wrong-channel") f.state.channel = { id: "C456", name: "other" };
  if (kind === "invalid-name") f.state.channel = { id: "C123", name: "bad\nname" };
  if (kind === "installation") await f.platform.repository.revokeInstallation("A123", "T123");
  if (kind === "link") await f.platform.repository.removeLink("A123", "T123", f.target.ownerId);
  expect(await (await f.request()).json()).toEqual({available:false}); expect(await f.rows()).toBe(0);
});
it.each(["runtime", "member", "installation"] as const)("rechecks %s authority after awaiting provider metadata", async kind => {
  const f = await fixture();
  f.api.conversationInfo.mockImplementationOnce(async () => {
    if (kind === "runtime") f.state.runtime = {...f.target, runtimeId:"runtime_replaced"};
    if (kind === "member") f.state.member = false;
    if (kind === "installation") await f.platform.repository.revokeInstallation("A123", "T123");
    return {canAccess:true,isExternalShared:false,channelMetadata:{id:"C123",name:"tech"}};
  });
  expect(await (await f.request()).json()).toEqual({available:false});
});
it.each(["binding", "lifecycle", "sharing"] as const)("rechecks local %s after discovery and exposes no stale source", async kind => {
  const f = await fixture();
  f.api.conversationInfo.mockImplementationOnce(async () => {
    if (kind === "binding") await f.db.updateTable("bot_chat_bindings").set({removed_at:new Date()}).where("chat_id","=",f.target.chatId).execute();
    if (kind === "lifecycle") await f.db.updateTable("chats").set({lifecycle:"deleted"}).where("id","=",f.target.chatId).execute();
    if (kind === "sharing") await sql`INSERT INTO collaboration_scopes
      (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
      VALUES ('20000000-0000-4000-8000-000000000b94','personal',${f.target.ownerId},'chat',${f.target.chatId},'direct','shared',1,1,'vps:enrollment',1,now(),now())`.execute(f.db);
    return {canAccess:true,isExternalShared:false,channelMetadata:{id:"C123",name:"tech"}};
  });
  expect(await f.context.enrollment({...f.target,signal:AbortSignal.timeout(5000)})).toBeUndefined();
});
it("checks local target and cancellation before any discovery/provider request", async () => {
  const f = await fixture();
  for(const patch of [{ownerId:"user_other"},{botId:"bot_87654321"},{chatId:"chat_other"}])
    expect(await f.context.enrollment({...f.target,...patch,signal:AbortSignal.timeout(5000)})).toBeUndefined();
  expect(await f.context.enrollment({...f.target,signal:AbortSignal.abort()})).toBeUndefined();
  expect(f.discovery).not.toHaveBeenCalled();expect(f.api.conversationInfo).not.toHaveBeenCalled();
});
it("never falls back to a cached event when configured discovery denies, throws, returns malformed metadata or another target", async () => {
  const f = await fixture();
  expect(await f.context.receive({...f.access,event:{appId:"A123",teamId:"T123",channelId:"C123",eventId:"EvCache",ts:"1795000001.000001",threadTs:"1795000000.000001",userId:"U123",text:"synthetic cached source"}})).toBe(true);
  const good = await (await f.request()).json();
  for(const response of [{available:false}, {...good,channel:{id:"C456",name:"other"}}, {...good,access:{...f.access,ownerId:"user_other"}}, {...good,scope:"thread",threadTs:undefined}, {...good,unexpected:"field"}]){
    f.discovery.mockResolvedValueOnce(response as never);
    expect(await f.context.enrollment({...f.target,signal:AbortSignal.timeout(5000)})).toBeUndefined();
  }
  f.discovery.mockRejectedValueOnce(new Error("fixture-unavailable"));
  expect(await f.context.enrollment({...f.target,signal:AbortSignal.timeout(5000)})).toBeUndefined();
  // Only an explicitly legacy caller without a discovery callback uses retained events.
  const legacy = await createPrivateSlackThreadContext({db:f.db,ownerId:f.target.ownerId,runtimeId:f.target.runtimeId,authorize:async()=>true});
  expect(await legacy.enrollment({...f.target,signal:AbortSignal.timeout(5000)})).toMatchObject({access:f.access,channel:{id:"C123"}});
});
it("keeps discovered legacy thread grants pinned to their root in native projection and calls", async () => {
  const f = await fixture("thread"), read = vi.fn(f.client.readEnrolledContext);
  const source = createEnrolledSlackReadSource({context:f.context,read});
  const binding = {...f.target,requestClass:"interactive"} as never;
  const inventory = await source.inventory(binding,AbortSignal.timeout(5000));
  expect(inventory).toContain('ts:"1795000000.000001"');expect(inventory).not.toContain("list_messages params");
  const connectionId=inventory!.match(/slack_enrolled_[a-f0-9]{32}/)![0];
  for(const [action,params] of [["list_messages",{}],["list_replies",{ts:"1795000002.000001"}]] as const)
    await expect(source.call(binding,{service:"slack",action,connectionId,params},AbortSignal.timeout(5000))).rejects.toMatchObject({code:"not_granted"});
  expect(read).not.toHaveBeenCalled();
  f.api.replies.mockResolvedValue({messages:[{user:"U456",ts:"1795000000.000001",text:"Only the enrolled thread"}],hasMore:false});
  const result=await source.call(binding,{service:"slack",action:"list_replies",connectionId,params:{ts:"1795000000.000001"}},AbortSignal.timeout(5000));
  expect(JSON.stringify(result)).toContain("Only the enrolled thread");
  expect(f.api.replies).toHaveBeenCalledWith(expect.objectContaining({channelId:"C123",ts:"1795000000.000001"}));
});
it("normalizes provider failures and malformed/oversized client responses to unavailable", async () => {
  const f = await fixture();f.api.conversationInfo.mockRejectedValueOnce(new Error("SECRET provider detail"));
  const response = await f.request();expect(response.status).toBe(503);expect(await response.text()).not.toContain("SECRET");
  f.api.conversationInfo.mockImplementationOnce(async () => {
    await new Promise(resolve=>setTimeout(resolve,1600));
    return {canAccess:true,isExternalShared:false,channelMetadata:{id:"C123",name:"tech"}};
  });
  expect(await f.client.discoverThreadEnrollment(f.target,AbortSignal.timeout(5000))).toEqual({available:false});
  for(const body of [{available:true}, {available:false,token:"private"}, "x".repeat(20000)]) {
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"pr-3482",token:"a".repeat(64),fetchImpl:async()=>Response.json(body)});
    expect(await client.discoverThreadEnrollment(f.target,AbortSignal.timeout(5000))).toEqual({available:false});
  }
});
it("discards discovery if cancellation arrives during the final local bot revalidation", async () => {
  const f=await fixture(),controller=new AbortController();let checks=0;
  const context=await createPrivateSlackThreadContext({db:f.db,ownerId:f.target.ownerId,runtimeId:f.target.runtimeId,authorize:async()=>true,
    discoverEnrollment:f.discovery,botAvailable:async()=>{if(++checks===2)controller.abort();return true;}});
  expect(await context.enrollment({...f.target,signal:controller.signal})).toBeUndefined();
});
