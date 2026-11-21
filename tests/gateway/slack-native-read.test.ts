import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createEnrolledSlackReadSource } from "../../packages/gateway/src/slack/enrolled-read-source.js";
import { registerOwnerSlack } from "../../packages/gateway/src/startup/slack-owner.js";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import { createBotIntegrationTools } from "../../packages/gateway/src/bots/integration-tools.js";
import { createBotIntegrationClient } from "../../packages/gateway/src/bots/integration-client.js";
import { createBotRecipeCatalog } from "../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotStateTransactions } from "../../packages/gateway/src/bots/events.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createBotToolDispatcher } from "../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotBrokerActions } from "../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import { createBotTasksRepository } from "../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotSessionsRepository } from "../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../packages/gateway/src/bots/repositories/checkpoints.js";
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse())
  await cleanup(); });
async function fixture(scope: "channel" | "thread" = "channel") {
  const state = await createRealBotStateDatabase();
  close.push(state.destroy);
  const { db } = state;
  const ownerId = "user_native", botId = "bot_12345678", chatId = "chat_native123", runtimeId = "runtime_native";
  const now = new Date(), root = "1795000000.000001", token = "a".repeat(64);
  await insertChat(db, chatId, ownerId);
  await db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: now, removed_at: null }).execute();
  const grant = { ownerId, botId, chatId, runtimeId, appId: "A123", teamId: "T123", channelId: "C123", ...(scope === "thread" ? { threadTs: root } : {}), organizationId: "org_native", ownerSlackId: "U123", installationGeneration: 1, linkCreatedAt: now.toISOString(), scope };
  const grantId = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
  const config = { appId: "A123", clientId: "123.456", clientSecret: "c".repeat(32), signingSecret: "s".repeat(32), tokenEncryptionKey: Buffer.alloc(32, 42).toString("base64"), publicBaseUrl: "https://platform.example" };
  let allowed = true;
  let runtime = { ownerId, runtimeId };
  const api = { conversationInfo: vi.fn(async () => ({ canAccess: true, isExternalShared: false, channelMetadata: { id: "C123", name: "tech" } })), hasChannelMember: vi.fn(async () => allowed), exchangeCode: vi.fn(), postMessage: vi.fn(), addReaction: vi.fn(),
    history: vi.fn(async () => ({ messages: [{ user: "U456", ts: root, text: "Native-only discussion: launch Friday" }], hasMore: false })),
    replies: vi.fn(async () => ({ messages: [{ user: "U456", ts: root, text: "Native-only discussion: launch Friday" }, { user: "U789", ts: "1795000001.000001", thread_ts: root, text: "I will prepare the checklist" }], hasMore: false })) };
  const platform = await createSlackApp({ db: db as unknown as Kysely<SlackDatabase>, config, api, startCleanup: false, now: () => now, contextGrant: grant, dispatch: vi.fn(), resolveActor: async () => null, requireOrgAdmin: async () => false, isCurrentMember: async () => allowed, authorizeChannelBinding: async () => false, resolveDestination: async () => ({ ownerId, runtimeId }), authenticateRuntime: async () => runtime });
  close.push(platform.close);
  await platform.repository.saveInstallation({ appId: "A123", teamId: "T123", organizationId: "org_native", installedBy: ownerId, botUserId: "UBOT", encryptedBotToken: encryptSlackToken("xoxb-fixture", config.tokenEncryptionKey, "A123:T123") });
  await platform.repository.createChallenge({ hash: "f".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
  await platform.repository.completeLink({ hash: "f".repeat(64), actorId: ownerId, organizationId: "org_native" });
  const client = createSlackOwnerClient({ platformUrl: config.publicBaseUrl, handle: "pr-3482", token, fetchImpl: async (url, init) => platform.routes.fetch(new Request(url, init)) });
  const context = await createPrivateSlackThreadContext({ db, ownerId, runtimeId, authorize: client.readThreadContextAccess });
  const gateway = new Hono();
  const owner = registerOwnerSlack({ app: gateway, ownerId, token, context, startDrain: false, authority: { authorize: async () => { throw new Error("No sharing"); } } });
  close.push(owner.close);
  const transport = createSlackHomeTransport({ fetchImpl: async (url, init) => gateway.fetch(new Request(url, init)) });
  await transport({ ownerId, token, origin: "https://gateway.example" }, "context", { ownerId, botId, chatId, runtimeId, grantId, event: { appId: "A123", teamId: "T123", channelId: "C123", threadTs: root, ts: "1795000001.000001", userId: "U789", eventId: "EvNative", text: "Stored source grants access, not the requested discussion" } });
  const source = createEnrolledSlackReadSource({ context, read: client.readEnrolledContext });
  const accountTransport = vi.fn(async () => new Response(null, { status: 503 }));
  const tools = createBotIntegrationTools({ client: createBotIntegrationClient(accountTransport), enrolledSlack: source, transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)), recipes: createBotRecipeCatalog(), agents: { get: async () => ({ id: botId, recipeRef: { recipeId: "personal-assistant", version: "2026-09-30.1" } } as never) } });
  const task = await createBotTasksRepository(db).create({ ownerId, botId, chatId, now: now.toISOString() });
  const binding: BotRuntimeBinding = { ownerId, botId, chatId, taskId: task.taskId, runId: "run_native", runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "1", rootFingerprint: "f".repeat(64), capabilities: ["integration.inventory", "integration.call"], requestClass: "interactive", accessSourceId: "matrix_included", route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 } };
  const registry = new BotRuntimeRegistry();
  registry.bind(binding);
  close.push(async () => registry.shutdown());
  const actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db), runs: { loadRunSpec: async () => { throw new Error("Not needed"); }, readImageChunk: async () => { throw new Error("No images"); } }, events: { publish: async () => { } }, tools: createBotToolDispatcher({ homePath: "/synthetic", integrations: tools }), inference: { homePath: "/synthetic", lifetime: new AbortController().signal } });
  const call = async (capability: "integration.inventory" | "integration.call", args: unknown) => actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId, action: "bot.tool", tool: { toolCallId: `native_${randomUUID().replaceAll("-", "")}`, capability, args } });
  const inventory = await call("integration.inventory", { service: "slack" });
  const inventoryText = JSON.stringify(inventory);
  const connectionId = inventoryText.match(/slack_enrolled_[a-f0-9]{32}/)?.[0];
  return { db, api, platform, client, source, tools, binding, call, inventory, connectionId, accountTransport, root, grant, grantId, revoke() { allowed = false; }, changeRuntime() { runtime = { ownerId, runtimeId: "wrong_runtime" }; } };
}
it("uses native broker inventory/history/replies with the enrolled source while account transport is unavailable", async () => {
  const f = await fixture();
  expect(f.inventory).toMatchObject({ ok: true });
  expect(f.connectionId).toBeDefined();
  expect(JSON.stringify(f.inventory)).toContain("#tech");
  const read = await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} });
  expect(read).toMatchObject({ ok: true, result: { ok: true } });
  expect(JSON.stringify(read)).toContain("Native-only discussion");
  expect(JSON.stringify(read)).toContain("untrusted");
  const thread = await f.call("integration.call", { service: "slack", action: "list_replies", connectionId: f.connectionId, params: { ts: f.root } });
  expect(thread).toMatchObject({ ok: true, result: { ok: true } });
  expect(JSON.stringify(thread)).toContain("prepare the checklist");
  expect(JSON.stringify(thread)).toContain("message_ts");
  expect(f.api.history).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C123", signal: expect.any(AbortSignal) }));
  expect(f.api.postMessage).not.toHaveBeenCalled();
  expect(f.api.addReaction).not.toHaveBeenCalled();
  expect(await f.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
  const checkpoints = await f.db.selectFrom("bot_tool_checkpoints").select(["effect_class", "phase"]).execute();
  expect(checkpoints.every(row => row.effect_class === "read" && row.phase === "observed_complete")).toBe(true);
});
it("denies writes, arbitrary selectors, changed identities and revoked native sources without generic fallback", async () => {
  const f = await fixture();
  expect(f.connectionId).toBeDefined();
  for (const [action, params] of [["send_message", { text: "no" }], ["search", { query: "all" }], ["react", {}], ["list_messages", { channel: "C456" }], ["list_messages", { cursor: "foreign" }], ["list_replies", { ts: "../escape" }]] as const) {
    const result = await f.call("integration.call", { service: "slack", action, connectionId: f.connectionId, params });
    expect(result).toMatchObject({ ok: false });
  }
  for (const patch of [{ ownerId: "user_other" }, { botId: "bot_98765432" }, { chatId: "chat_other" }, { group: { scopeId: "shared", actorId: "user_other" } }, { readonlySummary: true }])
    await expect(f.source.inventory({ ...f.binding, ...patch } as never, AbortSignal.timeout(5000))).resolves.toBeUndefined();
  const before = f.accountTransport.mock.calls.length;
  f.revoke();
  expect(await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} })).toMatchObject({ ok: false });
  expect(f.accountTransport.mock.calls.length).toBe(before);
});
it("keeps legacy thread enrollment from widening to recent channel history", async () => {
  const f = await fixture("thread");
  expect(f.connectionId).toBeDefined();
  expect(await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} })).toMatchObject({ ok: false });
  expect(await f.call("integration.call", { service: "slack", action: "list_replies", connectionId: f.connectionId, params: { ts: "1795000002.000001" } })).toMatchObject({ ok: false });
  expect(await f.call("integration.call", { service: "slack", action: "list_replies", connectionId: f.connectionId, params: { ts: f.root } })).toMatchObject({ ok: true, result: { ok: true } });
  expect(f.api.history).not.toHaveBeenCalled();
});
it("bounds native paging/results and fails closed on wrong roots, provider errors and in-flight revocation", async () => {
  const f = await fixture();
  const invoke = (action = "list_messages", params: Record<string, unknown> = {}) => f.call("integration.call", { service: "slack", action, connectionId: f.connectionId, params });
  let pages = 0;
  f.api.history.mockImplementation(async () => ({ messages: [{ user: "U456", ts: `179500000${pages++}.000001`, text: "page source" }], hasMore: true, nextCursor: `cursor${pages}` }));
  const paged = await invoke();
  expect(paged).toMatchObject({ ok: true });
  expect(f.api.history).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(paged)).toContain('\\"partial\\":true');
  expect(JSON.stringify(paged)).not.toContain("cursor1");
  f.api.history.mockResolvedValueOnce({ messages: [{ user: "U456", ts: f.root, text: "x".repeat(20000) }], hasMore: false });
  const capped = await invoke();
  expect(capped).toMatchObject({ ok: true });
  expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThan(18 * 1024);
  expect(JSON.stringify(capped)).not.toContain("x".repeat(100));
  f.api.replies.mockResolvedValueOnce({ messages: [{ user: "U456", ts: "1795000099.000001", text: "WRONG ROOT PRIVATE TEXT" }], hasMore: false });
  expect(await invoke("list_replies", { ts: f.root })).toMatchObject({ ok: false });
  f.api.history.mockRejectedValueOnce(new Error("SECRET_PROVIDER_FAILURE"));
  const failed = await invoke();
  expect(failed).toMatchObject({ ok: false });
  expect(JSON.stringify(failed)).not.toContain("SECRET_PROVIDER");
  f.api.history.mockImplementationOnce(async () => { f.revoke(); return { messages: [{ user: "U456", ts: f.root, text: "REVOKED SECRET SOURCE" }], hasMore: false }; });
  const revoked = await invoke();
  expect(revoked).toMatchObject({ ok: false });
  expect(JSON.stringify(revoked)).not.toContain("REVOKED SECRET");
});
it("rechecks local private binding after the provider read and hides all returned text after retirement", async () => {
  const f = await fixture();
  f.api.history.mockImplementationOnce(async () => { await f.db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("chat_id", "=", f.binding.chatId).execute(); return { messages: [{ user: "U456", ts: f.root, text: "RETIRED SECRET SOURCE" }], hasMore: false }; });
  const result = await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} });
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).not.toContain("RETIRED SECRET");
});
it("keeps a complete native response inside16KiB even at the boolean byte boundary", async () => {
  const f = await fixture();
  const access = { ownerId: f.binding.ownerId, botId: f.binding.botId, chatId: f.binding.chatId, runtimeId: f.grant.runtimeId, grantId: f.grantId, manual: { operation: "recent" as const } };
  const base = await f.client.readEnrolledContext(access, AbortSignal.timeout(5000));
  const text = base.messages[0]!.text!;
  const room = 16 * 1024 - Buffer.byteLength(JSON.stringify(base));
  f.api.history.mockResolvedValueOnce({ messages: [{ user: "U456", ts: f.root, text: text + "x".repeat(room + 1) }], hasMore: false });
  const result = await f.client.readEnrolledContext(access, AbortSignal.timeout(5000));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
  expect(result.partial).toBe(true);
});

it.each(["runtime", "external-share", "wrong-channel", "installation-generation", "link-removed", "link-generation"] as const)("denies native read after %s changes without invoking history or a generic account", async change => {
  const f = await fixture();
  const accountCalls = f.accountTransport.mock.calls.length;
  if (change === "runtime") f.changeRuntime();
  else if (change === "external-share") f.api.conversationInfo.mockResolvedValue({ canAccess: true, isExternalShared: true, channelMetadata: { id: "C123", name: "tech" } });
  else if (change === "wrong-channel") f.api.conversationInfo.mockResolvedValue({ canAccess: true, isExternalShared: false, channelMetadata: { id: "C456", name: "other" } });
  else if (change === "installation-generation") {
    const installed = (await f.platform.repository.getInstallation("A123", "T123"))!;
    const { generation: _generation, state: _state, ...installation } = installed;
    await f.platform.repository.saveInstallation(installation);
  }
  else if (change === "link-removed") await f.platform.repository.removeLink("A123", "T123", f.binding.ownerId);
  else await sql`UPDATE slack_employee_links SET created_at = created_at + interval '1 second' WHERE actor_id = ${f.binding.ownerId}`.execute(f.db);
  const result = await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} });
  expect(result).toMatchObject({ ok: false });
  expect(f.api.history).not.toHaveBeenCalled();
  expect(f.api.replies).not.toHaveBeenCalled();
  expect(f.accountTransport.mock.calls.length).toBe(accountCalls);
  expect(f.api.postMessage).not.toHaveBeenCalled();
  expect(f.api.addReaction).not.toHaveBeenCalled();
});

it("discards a native provider result when the Chat becomes historically shared during its fetch", async () => {
  const f = await fixture();
  const accountCalls = f.accountTransport.mock.calls.length;
  f.api.history.mockImplementationOnce(async () => {
    await sql`INSERT INTO collaboration_scopes
      (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
      VALUES ('20000000-0000-4000-8000-000000000b93','personal',${f.binding.ownerId},'chat',${f.binding.chatId},'direct','shared',1,1,'vps:native',1,now(),now())`.execute(f.db);
    return { messages: [{ user: "U456", ts: f.root, text: "SHARED DURING FETCH SECRET" }], hasMore: false };
  });
  const result = await f.call("integration.call", { service: "slack", action: "list_messages", connectionId: f.connectionId, params: {} });
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).not.toContain("SHARED DURING FETCH");
  expect(f.api.history).toHaveBeenCalledTimes(1);
  expect(f.accountTransport.mock.calls.length).toBe(accountCalls);
  expect(await f.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
});
