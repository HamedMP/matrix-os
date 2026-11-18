import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

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

it("adds a signed unmentioned reply to only the selected private bot context without creating a Run or Slack write", async () => {
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
  const gateway = new Hono();
  let loseNextAck = false;
  const home = createSlackHomeTransport({ fetchImpl: async (url, init) => {
    const result = await gateway.fetch(new Request(url, init));
    if (!loseNextAck) return result;
    loseNextAck = false;
    await result.body?.cancel();
    return new Response(null, { status: 503 });
  } });
  const api = {
    conversationInfo: vi.fn(async () => ({ isExternalShared: false, canAccess: true })),
    hasChannelMember: vi.fn(async () => true),
    exchangeCode: vi.fn(), postMessage: vi.fn(), replies: vi.fn(), history: vi.fn(), addReaction: vi.fn(),
  };
  let requesterRuntimeId = runtimeId;
  const platform = await createSlackApp({
    db: fixture.db as unknown as Kysely<SlackDatabase>, config, api, startCleanup: false, now: () => linkCreatedAt,
    resolveActor: async () => null, requireOrgAdmin: async () => false, isCurrentMember: async () => true,
    authorizeChannelBinding: async () => false, authorizeReply: async () => true,
    resolveDestination: async () => ({ ownerId, runtimeId }), dispatch: vi.fn(),
    authenticateRuntime: async () => ({ ownerId, runtimeId: requesterRuntimeId }),
    contextGrant: grant, dispatchContext: envelope => home({ ownerId, token, origin: "https://gateway.example" }, "context", envelope).then(() => {}),
  });
  cleanup.push(platform.close);
  await platform.repository.saveInstallation({ appId, teamId, organizationId, installedBy: ownerId, botUserId: "UBOT",
    encryptedBotToken: encryptSlackToken("xoxb-local-fixture", config.tokenEncryptionKey, `${appId}:${teamId}`) });
  await platform.repository.createChallenge({ hash: "f".repeat(64), appId, teamId, slackUserId: ownerSlackId });
  await platform.repository.completeLink({ hash: "f".repeat(64), actorId: ownerId, organizationId });
  const ownerClient = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle: "pr-3482", token,
    fetchImpl: (url, init) => Promise.resolve(platform.routes.fetch(new Request(url, init))) });
  const context = await createPrivateSlackThreadContext({
    db: fixture.db, ownerId, runtimeId, authorize: ownerClient.canReadThreadContext,
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

  expect((await push("EvOtherThread", { thread_ts: "1700000000.000300", text: "Other thread reply" })).status).toBe(200);
  expect((await push("EvExternal", { is_ext_shared: true, ts: "1700000001.000500", text: "External reply" })).status).toBe(200);
  expect((await push("EvPlainReply")).status).toBe(200);
  expect((await push("EvPlainReply")).status).toBe(200);
  expect((await push("EvSameMessage")).status).toBe(200);
  const read = () => context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) });
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

  const source = await read();
  expect(source).toContain("untrusted reference");
  expect(source).toContain("U456");
  expect(source).not.toMatch(/Other thread reply|External reply/);
  expect(source?.match(/A plain Slack reply/g)).toHaveLength(1);
  expect(await context.prompt({ ownerId, botId: "bot_98765432", chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  requesterRuntimeId = "other_runtime";
  expect(await context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  requesterRuntimeId = runtimeId;
  await fixture.db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("chat_id", "=", chatId).execute();
  expect(await read()).toBeUndefined();
  await fixture.db.updateTable("bot_chat_bindings").set({ removed_at: null }).where("chat_id", "=", chatId).execute();
  await platform.repository.removeLink(appId, teamId, ownerId);
  expect(await context.prompt({ ownerId, botId, chatId, signal: AbortSignal.timeout(5_000) })).toBeUndefined();
  expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
  expect(await fixture.db.selectFrom("chat_queued_turns").select("id").execute()).toHaveLength(0);
  expect(api.replies).not.toHaveBeenCalled();
  expect(api.postMessage).not.toHaveBeenCalled();
  expect(api.addReaction).not.toHaveBeenCalled();
});
