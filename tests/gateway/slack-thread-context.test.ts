import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { SlackThreadContextEnvelope } from "@matrix-os/contracts/slack-bridge";

import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import { registerOwnerSlack } from "../../packages/gateway/src/startup/slack-owner.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";

const ownerId = "user_context_owner";
const appId = "A123";
const teamId = "T123";
const organizationId = "org_context";
const ownerSlackId = "U123";
const channelId = "C123";
const threadTs = "1700000000.000100";
const botId = "bot_12345678";
const runtimeId = "preview_runtime";
const token = "a".repeat(64);
const config = { appId, clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32),
  tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://platform.example" };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(["legacy-thread", "thread", "channel"] as const)("adds signed ordinary messages through a %s grant without creating a Run or Slack write", async scope => {
  const fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  cleanup.push(fixture.destroy);
  const chatId = "chat_12345678";
  await insertChat(fixture.db, chatId, ownerId);
  await fixture.db.insertInto("bot_chat_bindings").values({
    owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: new Date(), removed_at: null,
  }).execute();
  const linkCreatedAt = new Date();
  const grant = { appId, teamId, organizationId, ownerId, ownerSlackId, channelId, threadTs, botId, chatId,
    runtimeId, installationGeneration: 1, linkCreatedAt: linkCreatedAt.toISOString() };
  const { threadTs: _root, ...channelGrant } = grant;
  const contextGrant = scope === "channel" ? { ...channelGrant, scope } : scope === "thread" ? { ...grant, scope } : grant;
  const gateway = new Hono();
  let loseNextAck = false;
  const home = createSlackHomeTransport({ fetchImpl: async (url, init) => {
    const result = await gateway.fetch(new Request(url, init));
    if (!loseNextAck) return result;
    loseNextAck = false;
    await result.body?.cancel();
    return new Response(null, { status: 503 });
  } });
  const conversationInfo = vi.fn().mockResolvedValue({ isExternalShared: false, canAccess: true });
  const api = {
    conversationInfo,
    hasChannelMember: vi.fn(async () => true),
    exchangeCode: vi.fn(), postMessage: vi.fn(), replies: vi.fn(), history: vi.fn(), addReaction: vi.fn(),
  };
  let requesterRuntimeId = runtimeId;
  let currentMember = true;
  const dispatch = vi.fn();
  const dispatchContext = vi.fn((envelope: SlackThreadContextEnvelope) =>
    home({ ownerId, token, origin: "https://gateway.example" }, "context", envelope).then(() => {}));
  const platform = await createSlackApp({
    db: fixture.db as unknown as Kysely<SlackDatabase>, config, api, startCleanup: false, now: () => linkCreatedAt,
    resolveActor: async () => null, requireOrgAdmin: async () => false, isCurrentMember: async () => currentMember,
    authorizeChannelBinding: async () => false, authorizeReply: async () => true,
    resolveDestination: async () => ({ ownerId, runtimeId }), dispatch,
    authenticateRuntime: async () => ({ ownerId, runtimeId: requesterRuntimeId }),
    contextGrant, dispatchContext,
  });
  cleanup.push(platform.close);
  await platform.repository.saveInstallation({ appId, teamId, organizationId, installedBy: ownerId, botUserId: "UBOT",
    encryptedBotToken: encryptSlackToken("xoxb-local-fixture", config.tokenEncryptionKey, `${appId}:${teamId}`) });
  await platform.repository.createChallenge({ hash: "f".repeat(64), appId, teamId, slackUserId: ownerSlackId });
  await platform.repository.completeLink({ hash: "f".repeat(64), actorId: ownerId, organizationId });
  const ownerClient = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle: "pr-3482", token,
    fetchImpl: (url, init) => Promise.resolve(platform.routes.fetch(new Request(url, init))) });
  const context = await createPrivateSlackThreadContext({
    db: fixture.db, ownerId, runtimeId, authorize: ownerClient.readThreadContextAccess,
  });
  const ownerSlack = registerOwnerSlack({ app: gateway, ownerId, token, startDrain: false, context,
    authority: { async authorize() { throw new Error("Unexpected collaboration request"); } } });
  cleanup.push(ownerSlack.close);

  const push = async (id: string, overrides: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ type: "event_callback", api_app_id: appId, team_id: teamId, event_id: id,
      event: { type: "message", channel_type: "channel", user: "U456", channel: channelId,
        thread_ts: threadTs, ts: "1700000001.000200", text: "A plain Slack reply", ...overrides } });
    const timestamp = String(Math.floor(linkCreatedAt.getTime() / 1000));
    const signature = createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
    return platform.routes.request("/webhooks/slack/events", { method: "POST", body,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` } });
  };

  expect((await push("EvOtherThread", { thread_ts: "1700000000.000300", ts: "1700000001.000400", text: "Other thread reply" })).status).toBe(200);
  expect((await push("EvTopLevel", { thread_ts: undefined, ts: "1700000000.000700", text: "Ordinary top-level post" })).status).toBe(200);
  expect((await push("EvTopLevel", { thread_ts: undefined, ts: "1700000000.000700", text: "Ordinary top-level post" })).status).toBe(200);
  expect((await push("EvOtherChannel", { channel: "C456", ts: "1700000001.000600", text: "Wrong channel post" })).status).toBe(200);
  expect((await push("EvExternal", { is_ext_shared: true, ts: "1700000001.000500", text: "External reply" })).status).toBe(200);
  for (const [id, overrides] of [
    ["EvBot", { bot_id: "B123", user: "UBOT" }],
    ["EvApp", { app_id: appId }],
    ["EvSubtype", { subtype: "message_changed" }],
    ["EvForeignSender", { user_team: "T456" }],
  ] as const) {
    expect((await push(id, { ...overrides, ts: "1700000001.000800", text: "Filtered source" })).status).toBe(200);
  }
  expect((await push("EvPlainReply")).status).toBe(200);
  expect((await push("EvPlainReply")).status).toBe(200);
  expect((await push("EvSameMessage")).status).toBe(200);
  const read = () => context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) });
  const infoBeforeRead = conversationInfo.mock.calls.length;
  conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true, channelMetadata: { id: channelId, name: "tech" } });
  const namedSource = await read();
  expect(namedSource).toContain('"channelName":"#tech"');
  expect(namedSource).toContain("A plain Slack reply");
  expect(conversationInfo.mock.calls.length).toBe(infoBeforeRead + 1);
  conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true, channelMetadata: { id: "C456", name: "wrong-label" } });
  expect(await read()).toBeUndefined();
  conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true });
  const idOnly = await read();
  expect(idOnly).toContain(channelId);
  expect(idOnly).not.toContain("channelName");
  conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true, channelMetadata: { id: channelId, name: "tech" } });

  expect(await platform.repository.getReplyDestination({ appId, teamId, eventId: "EvPlainReply" })).toBeNull();
  await expect(context.prompt({ ownerId, botId, chatId: "chat_other", signal: AbortSignal.timeout(5_000) })).resolves.toBeUndefined();
  api.hasChannelMember.mockResolvedValueOnce(false);
  expect((await push("EvNoMember", { ts: "1700000001.000300", text: "Denied member reply" })).status).toBe(200);
  expect(await read()).not.toContain("Denied member reply");
  api.hasChannelMember.mockResolvedValueOnce(false);
  expect(await read()).toBeUndefined();
  loseNextAck = true;
  const recovered = { ts: "1700000001.000301", text: "Recovered reply" };
  expect((await push("EvLostAck", recovered)).status).toBe(503);
  expect((await push("EvLostAck", recovered)).status).toBe(200);
  expect((await read())?.match(/Recovered reply/g)).toHaveLength(1);

  const access = { ownerId, botId, chatId, runtimeId,
    grantId: dispatchContext.mock.calls[0]![0].grantId };
  expect(await ownerClient.canReadThreadContext(access, AbortSignal.timeout(5_000))).toBe(true);
  const legacy = await platform.routes.request("/internal/slack/thread-context/access", {
    method: "POST", body: JSON.stringify(access),
  });
  expect(await legacy.json()).toEqual({ allowed: true });

  const source = await read();
  expect(source).toContain("untrusted reference");
  expect(source).toContain('"channelName":"#tech"');
  expect(Buffer.byteLength(source!)).toBeLessThanOrEqual(4096);
  expect(source).toContain("U456");
  expect(source).not.toMatch(/Wrong channel post|External reply|Filtered source/);
  if (scope === "channel") {
    expect(source).toContain("Other thread reply");
    expect(source?.match(/Ordinary top-level post/g)).toHaveLength(1);
    expect(source).toContain('"thread":"1700000000.000700"');
  } else {
    expect(source).not.toMatch(/Other thread reply|Ordinary top-level post/);
  }
  expect(source?.match(/A plain Slack reply/g)).toHaveLength(1);
  const name = "频".repeat(80);
  conversationInfo.mockResolvedValue({ isExternalShared: false, canAccess: true, channelMetadata: { id: channelId, name } });
  for (let index = 0; index < 3; index += 1) {
    expect((await push(`EvBudget${index}`, { ts: `1700000002.00000${index}`, text: "文".repeat(1000) })).status).toBe(200);
  }
  const budgeted = await read();
  expect(budgeted).toContain(`#${name}`);
  expect(Buffer.byteLength(budgeted!)).toBeLessThanOrEqual(4096);
  expect(budgeted?.match(/channelName/g)).toHaveLength(1);
  expect(await context.prompt({ ownerId, botId: "bot_98765432", chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  currentMember = false;
  expect(await read()).toBeUndefined();
  expect((await push("EvRevokedMember", { ts: "1700000001.000900", text: "Revoked source" })).status).toBe(200);
  currentMember = true;
  expect(await read()).not.toContain("Revoked source");
  requesterRuntimeId = "other_runtime";
  expect(await context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  requesterRuntimeId = runtimeId;
  await fixture.db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("chat_id", "=", chatId).execute();
  expect(await read()).toBeUndefined();
  await fixture.db.updateTable("bot_chat_bindings").set({ removed_at: null }).where("chat_id", "=", chatId).execute();
  await platform.repository.removeLink(appId, teamId, ownerId);
  expect(await context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  expect(await fixture.db.selectFrom("chat_turns").select("id").execute()).toHaveLength(0);
  expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
  expect(await fixture.db.selectFrom("chat_queued_turns").select("id").execute()).toHaveLength(0);
  expect(dispatch).not.toHaveBeenCalled();
  expect(api.replies).not.toHaveBeenCalled();
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(api.addReaction).not.toHaveBeenCalled();
});
