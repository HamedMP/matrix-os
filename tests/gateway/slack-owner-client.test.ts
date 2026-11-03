import { createHmac } from "node:crypto";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { bootstrapSlackDatabase, type SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { SlackRepository } from "../../packages/platform/src/slack/repository.js";
import { createSlackAppRoutes } from "../../packages/platform/src/slack/routes.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import {describe,it,expect,vi} from "vitest";
import {createSlackOwnerClient} from "../../packages/gateway/src/startup/slack-owner-client.js";
describe("Slack owner client",()=>{
  const envelope={event:{teamId:"T123",eventId:"Ev123"}} as never;
  it("rejects remote plaintext origins before any bearer token can be sent",()=>{
    const fetchImpl=vi.fn();
    for(const platformUrl of ["http://platform.example", "http://10.0.0.2", "http://localhost.example", "http://127.0.0.1.example"]){
      expect(()=>createSlackOwnerClient({platformUrl,handle:"alice",token:"a".repeat(64),fetchImpl})).toThrow("Slack transport unavailable");
    }
    for(const platformUrl of ["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000", "https://platform.example"]){
      expect(()=>createSlackOwnerClient({platformUrl,handle:"alice",token:"a".repeat(64),fetchImpl})).not.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("never sends a caller-selected Slack destination or credentials in source material",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({sent:true,messageTs:"123.45"})));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    expect(await client.sendReply({envelope,text:"answer"} as never)).toEqual({status:"sent",messageTs:"123.45"});
    const [url,init]=fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://platform.example/internal/slack/replies");
    expect(JSON.parse(init.body)).toEqual({teamId:"T123",eventId:"Ev123",text:"answer"});
    expect(init.redirect).toBe("error");expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("reacts only to the original receipt and never accepts a destination or emoji",async()=>{
    const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({reacted:true})));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    await client.react(envelope);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://platform.example/internal/slack/reactions");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({teamId:"T123",eventId:"Ev123"});
    fetchImpl.mockRejectedValue(new Error("network"));await expect(client.react(envelope)).resolves.toBeUndefined();
  });
  it("marks network outcomes uncertain and caps fetched thread context",async()=>{
    const fetchImpl=vi.fn().mockRejectedValue(new Error("network"));
    const client=createSlackOwnerClient({platformUrl:"https://platform.example",handle:"alice",token:"a".repeat(64),fetchImpl});
    expect(await client.sendReply({envelope,text:"answer"} as never)).toEqual({status:"uncertain"});
    fetchImpl.mockResolvedValue(new Response("x".repeat(20_000)));
    expect(await client.readThread(envelope)).toBeNull();
  });

  it.each(["initial_authority", "channel_metadata", "final_authority"] as const)
  ("retries only a proven no-send through the real platform route and owner client: %s", async (phase) => {
    const instance = await KyselyPGlite.create(); const db = new Kysely<SlackDatabase>({ dialect: instance.dialect });
    const clock = new Date("2026-09-30T10:00:00Z");
    const config = { appId: "A123", clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32),
      tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://platform.example" };
    const authorizeReply = vi.fn().mockResolvedValue(true);
    const api = { exchangeCode: vi.fn(), postMessage: vi.fn().mockResolvedValue({ ts: "123.999" }), replies: vi.fn(), history: vi.fn(),
      addReaction: vi.fn(), conversationInfo: vi.fn().mockResolvedValue({ isExternalShared: false, canAccess: true }) };
    await bootstrapSlackDatabase(db); const repository = new SlackRepository(db, { now: () => clock });
    const app = createSlackAppRoutes({ config, repository, api, resolveActor: async () => "user_employee",
      resolveDestination: async () => ({ ownerId: "user_employee", runtimeId: "runtime_original" }),
      requireOrgAdmin: async () => true, isCurrentMember: async () => true, authorizeChannelBinding: async () => true,
      authenticateRuntime: async () => ({ ownerId: "user_employee" }), authorizeReply,
      dispatch: async () => ({ ownerId: "user_employee" }), now: () => clock });
    try {
      await repository.saveInstallation({ appId: "A123", teamId: "T123", organizationId: "org_company", installedBy: "user_admin", botUserId: "UBOT",
        encryptedBotToken: encryptSlackToken("xoxb-synthetic", config.tokenEncryptionKey, "A123:T123") });
      await repository.createChallenge({ hash: "f".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
      await repository.completeLink({ hash: "f".repeat(64), actorId: "user_employee", organizationId: "org_company" });
      const body = JSON.stringify({ type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev123",
        event: { type: "message", channel_type: "im", user: "U123", channel: "D123", text: "hello", ts: "123.456" } });
      const timestamp = String(clock.getTime() / 1000);
      expect((await app.request("/webhooks/slack/events", { method: "POST", body, headers: { "content-type": "application/json",
        "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` } })).status).toBe(200);
      const timeout = new DOMException("Synthetic read timeout", "TimeoutError");
      if (phase === "initial_authority") authorizeReply.mockRejectedValueOnce(timeout);
      if (phase === "channel_metadata") api.conversationInfo.mockRejectedValueOnce(timeout);
      if (phase === "final_authority") authorizeReply.mockResolvedValueOnce(true).mockRejectedValueOnce(timeout);
      const client = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle: "alice", token: "a".repeat(64),
        fetchImpl: vi.fn(async (url, init) => app.request(String(url), init)) });
      const first = await client.sendReply({ envelope, text: "answer" });
      expect({ result: first, sends: api.postMessage.mock.calls.length,
        claims: await db.selectFrom("slack_reply_intents").selectAll().execute() }).toEqual({ result: { status: "retryable" }, sends: 0, claims: [] });
      expect(await client.sendReply({ envelope, text: "answer" })).toEqual({ status: "sent", messageTs: "123.999" });
      expect(await client.sendReply({ envelope, text: "answer" })).toEqual({ status: "sent", messageTs: "123.999" });
      expect(api.postMessage).toHaveBeenCalledOnce();
    } finally { await app.shutdownSlack(); await db.destroy(); }
  });
  it.each([
    [503, { error: "Try again later" }], [503, { error: "Unknown", code: "reply_not_sent" }],
    [503, { error: "Try again later", code: "reply_not_sent", extra: true }],
    [502, { error: "Try again later", code: "reply_not_sent" }], [503, { sent: true, messageTs: "123.999" }],
  ] as const)("does not retry an unproven no-send response: %s %j", async (status, body) => {
    const client = createSlackOwnerClient({ platformUrl: "https://platform.example", handle: "alice", token: "a".repeat(64),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status })) });
    expect(await client.sendReply({ envelope, text: "answer" })).toEqual({ status: "uncertain" });
  });

});
