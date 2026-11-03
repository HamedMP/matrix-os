import { createHash, createHmac } from "node:crypto";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapSlackDatabase, type SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { SlackRepository, SlackRepositoryError } from "../../packages/platform/src/slack/repository.js";
import { createSlackAppRoutes, type SlackAppRouteOptions } from "../../packages/platform/src/slack/routes.js";
import { createRealCollaborationTestDatabase } from "../gateway/collaboration-test-support.js";
import { createSlackApi } from "../../packages/platform/src/slack/api.js";
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
  resolveDestination:async({event})=>({ownerId:event.kind==="direct_message"?"user_employee":"user_admin",runtimeId:"runtime_original"}),
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


describe("Slack delivery recovery and dispatch fences", () => {
  const key = { appId: "A123", teamId: "T123", eventId: "Ev123" };
  const dm = { type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" };
  const reply = () => app.request("/internal/slack/replies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId: key.teamId, eventId: key.eventId, text: "answer" }) });
  it("retries a pending receipt after a lost home acknowledgement without publishing early", async () => {
    await linkEmployee();
    dispatch.mockRejectedValueOnce(new Error("home committed; ack lost"));
    expect((await app.request("/webhooks/slack/events", signed(envelope(dm)))).status).toBe(503);
    const waiting = await reply();
    expect(waiting.status).toBe(503);
    expect(await waiting.json()).toEqual({ error: "Delivery not ready", code: "receipt_not_ready" });
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(await db.selectFrom("slack_reply_intents").selectAll().execute()).toEqual([]);
    actor = "user_other"; expect((await reply()).status).toBe(403);
    actor = "user_employee";
    expect((await app.request("/webhooks/slack/events", signed(envelope(dm)))).status).toBe(200);
    expect((await reply()).status).toBe(200);
    expect(api.postMessage).toHaveBeenCalledOnce();
  });
  it.each(["membership", "destination", "receipt"])("does not dispatch after unlink during %s latency", async (phase) => {
    await linkEmployee();
    const unlink = () => repo.removeLink("A123", "T123", "user_employee");
    if (phase === "membership") app = makeApp({ isCurrentMember: async () => { await unlink(); return true; } });
    if (phase === "destination") app = makeApp({ resolveDestination: async () => { await unlink(); return { ownerId: "user_employee", runtimeId: "runtime_original" }; } });
    if (phase === "receipt") {
      const original = repo.recordDestination.bind(repo);
      vi.spyOn(repo, "recordDestination").mockImplementation(async (...args) => { await original(...args); await unlink(); });
    }
    expect((await app.request("/webhooks/slack/events", signed(envelope(dm)))).status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(["installation", "channel"])("does not dispatch after %s changes during destination persistence", async (change) => {
    await linkEmployee();
    const binding = { appId: "A123", teamId: "T123", organizationId: org, channelId: "C123", scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true, configuredBy: "user_admin" };
    await repo.saveChannelBinding(binding);
    const original = repo.recordDestination.bind(repo);
    vi.spyOn(repo, "recordDestination").mockImplementation(async (...args) => {
      await original(...args);
      if (change === "installation") await repo.revokeInstallation("A123", "T123");
      else await repo.saveChannelBinding({ ...binding, scopeId: "22222222-2222-4222-8222-222222222222" });
    });
    expect((await app.request("/webhooks/slack/events", signed(envelope(mention)))).status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("releases only a confirmed rate-limited claim and retries the same reply exactly once", async () => {
    await linkEmployee();
    await app.request("/webhooks/slack/events", signed(envelope(dm)));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "123.999" })));
    const realApi = createSlackApi({ clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl });
    api.postMessage.mockImplementation(realApi.postMessage);
    const limited = await reply(); expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("2");
    expect(await db.selectFrom("slack_reply_intents").selectAll().execute()).toEqual([]);
    expect((await reply()).status).toBe(200);
    expect((await reply()).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("sent");
  });
  it("retries a rate-limited metadata read without preparing or sending a reply", async () => {
    await linkEmployee();
    await app.request("/webhooks/slack/events", signed(envelope(dm)));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "999999" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { is_member: true, is_ext_shared: false } })));
    api.conversationInfo.mockImplementation(createSlackApi({ clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl }).conversationInfo);
    const limited = await reply();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3600");
    expect(await db.selectFrom("slack_reply_intents").selectAll().execute()).toEqual([]);
    expect(api.postMessage).not.toHaveBeenCalled();
    expect((await reply()).status).toBe(200);
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("sent");
  });
  it("keeps ambiguous provider failures blocked instead of releasing the claim", async () => {
    await linkEmployee(); await app.request("/webhooks/slack/events", signed(envelope(dm)));
    const fetchImpl = vi.fn().mockRejectedValue(new Error("response lost"));
    api.postMessage.mockImplementation(createSlackApi({ clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl }).postMessage);
    expect((await reply()).status).toBe(503); expect((await reply()).status).toBe(409);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("unknown");
  });

  it("releases only this invocation's unsent claim after final authorization times out", async () => {
    await linkEmployee(); await app.request("/webhooks/slack/events", signed(envelope(dm)));
    authorizeReply.mockResolvedValueOnce(true).mockRejectedValueOnce(new DOMException("Synthetic authorization timeout", "TimeoutError"));
    const response = await reply();
    const observed = { status: response.status, body: await response.json(), sends: api.postMessage.mock.calls.length,
      claims: await db.selectFrom("slack_reply_intents").selectAll().execute() };
    expect(observed).toEqual({ status: 503, body: { error: "Try again later", code: "reply_not_sent" }, sends: 0, claims: [] });
    expect((await reply()).status).toBe(200); expect((await reply()).status).toBe(200);
    expect(api.postMessage).toHaveBeenCalledOnce();
  });
  it("does not release another invocation's prepared claim when claiming fails or reports unknown", async () => {
    await linkEmployee(); await app.request("/webhooks/slack/events", signed(envelope(dm)));
    expect(await repo.claimReply(key, createHash("sha256").update("answer").digest("hex"))).toBe("claimed");
    const claim = vi.spyOn(repo, "claimReply").mockRejectedValueOnce(new Error("Synthetic database response failure"));
    expect((await reply()).status).toBe(503); claim.mockRestore();
    expect((await reply()).status).toBe(409); expect(api.postMessage).not.toHaveBeenCalled();
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("prepared");
  });
  it("never releases a claim after Slack sent but the sent-state database response failed", async () => {
    await linkEmployee(); await app.request("/webhooks/slack/events", signed(envelope(dm)));
    const settle = repo.settleReply.bind(repo);
    vi.spyOn(repo, "settleReply").mockRejectedValueOnce(new Error("Synthetic commit response failure")).mockImplementation(settle);
    expect((await reply()).status).toBe(503); expect((await reply()).status).toBe(409);
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("unknown");
  });

  it("withholds a no-send retry marker when exact prepared-claim release fails", async () => {
    await linkEmployee(); await app.request("/webhooks/slack/events", signed(envelope(dm)));
    const fetchImpl = vi.fn().mockResolvedValue(new Response("limited", { status: 429, headers: { "Retry-After": "2" } }));
    api.postMessage.mockImplementation(createSlackApi({ clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl }).postMessage);
    const release = vi.spyOn(repo, "releaseRateLimitedReply").mockRejectedValueOnce(new Error("Synthetic release failure"));
    const response = await reply(); expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("code", "reply_not_sent"); expect(release).toHaveBeenCalledOnce();
    expect((await db.selectFrom("slack_reply_intents").selectAll().executeTakeFirstOrThrow()).state).toBe("prepared");
    expect((await reply()).status).toBe(409); expect(fetchImpl).toHaveBeenCalledOnce();
  });

});
