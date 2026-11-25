import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSlackPlatform } from "../../packages/gateway/src/startup/slack-platform.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { startOwnerSlack } from "../../packages/gateway/src/startup/slack-owner.js";
import { signSlackBridgeRequest, signSlackContextSource } from "../../packages/contracts/src/slack-bridge.js";
const core = { PLATFORM_INTERNAL_URL: "https://core.example.test", UPGRADE_TOKEN: "c".repeat(64),
  MATRIX_HANDLE: "pr-3482", MATRIX_RUNTIME_SLOT: "pr-3482", MATRIX_MACHINE_ID: "11111111-2222-4333-8444-555555555555", MATRIX_PREVIEW_RUNTIME: "true" };
const preview = { ...core, MATRIX_SLACK_PLATFORM_URL: "https://pr-3482---matrix-platform-preview-fixture-ey.a.run.app",
  MATRIX_SLACK_PLATFORM_TOKEN: "a".repeat(64), MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN: "a".repeat(64) };
afterEach(() => vi.unstubAllGlobals());
it("preserves the legacy platform pair when no Slack override is configured", () => {
  expect(resolveSlackPlatform(core)).toEqual({ connection: { platformUrl: core.PLATFORM_INTERNAL_URL, token: core.UPGRADE_TOKEN, handle: core.MATRIX_HANDLE },
    botConnection: { platformUrl: core.PLATFORM_INTERNAL_URL, token: core.UPGRADE_TOKEN, handle: core.MATRIX_HANDLE, machineId: core.MATRIX_MACHINE_ID, runtimeSlot: core.MATRIX_RUNTIME_SLOT } });
});
it("selects the same isolated pair for owner transport and bot reads without mutating core configuration", () => {
  const before = structuredClone(preview), selected = resolveSlackPlatform(preview);
  expect(selected.connection).toEqual({ platformUrl: preview.MATRIX_SLACK_PLATFORM_URL, token: preview.MATRIX_SLACK_PLATFORM_TOKEN, handle: core.MATRIX_HANDLE });
  expect(selected.botConnection).toMatchObject(selected.connection!); expect(preview).toEqual(before);
});
it.each([
  { MATRIX_SLACK_PLATFORM_TOKEN: undefined }, { MATRIX_SLACK_PLATFORM_URL: undefined },
  { MATRIX_SLACK_PLATFORM_TOKEN: "" }, { MATRIX_SLACK_PLATFORM_TOKEN: "invalid" },
  { MATRIX_SLACK_PLATFORM_TOKEN: "a".repeat(64) + "\n", MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN: "a".repeat(64) + "\n" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL + "\n" },
  { MATRIX_SLACK_PLATFORM_URL: "https://user:password@pr-3482---matrix-platform-preview-fixture-ey.a.run.app" },
  { MATRIX_MACHINE_ID: undefined }, { MATRIX_MACHINE_ID: "" }, { MATRIX_MACHINE_ID: "opaque_runtime" },
  { MATRIX_PREVIEW_RUNTIME: "false" }, { MATRIX_RUNTIME_SLOT: "primary" }, { MATRIX_HANDLE: "primary", MATRIX_RUNTIME_SLOT: "primary" },
  { MATRIX_SLACK_PLATFORM_URL: "https://pr-3483---matrix-platform-preview-fixture-ey.a.run.app" },
  { MATRIX_SLACK_PLATFORM_URL: "https://matrix-platform-preview-fixture-ey.a.run.app" },
  { MATRIX_SLACK_PLATFORM_URL: "http://pr-3482---matrix-platform-preview-fixture-ey.a.run.app" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL + ":443" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL + "/path" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL + "?query=1" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL + "#fragment" },
  { MATRIX_SLACK_PLATFORM_URL: "https://localhost" }, { MATRIX_SLACK_PLATFORM_URL: "https://127.0.0.1" },
  { MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN: "b".repeat(64) },
])("disables only Slack on a partial or invalid override with no core fallback: %j", patch => {
  const env = { ...preview, ...patch }; expect(resolveSlackPlatform(env)).toEqual({ connection: undefined, botConnection: null });
  expect(env.PLATFORM_INTERNAL_URL).toBe(core.PLATFORM_INTERNAL_URL); expect(env.UPGRADE_TOKEN).toBe(core.UPGRADE_TOKEN);
});
it("uses selected credentials for actual owner RPC and signed receiver, rejecting the core HMAC", async () => {
  const selected = resolveSlackPlatform(preview), calls: Array<{ url: string; token: string | null }> = [];
  const client = createSlackOwnerClient({ ...selected.connection!, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), token: new Headers(init?.headers).get("authorization") });
    return Response.json({ allowed: true });
  } });
  const access = { ownerId: "user_fixture", botId: "bot_12345678", chatId: "chat_fixture", runtimeId: "runtime_fixture", grantId: "d".repeat(64) };
  expect(await client.canReadThreadContext(access, AbortSignal.timeout(1000))).toBe(true);
  expect(calls).toEqual([{ url: preview.MATRIX_SLACK_PLATFORM_URL + "/internal/slack/thread-context/access", token: `Bearer ${preview.MATRIX_SLACK_PLATFORM_TOKEN}` }]);
  const app = new Hono(), receive = vi.fn(async () => true);
  const runtime = await startOwnerSlack({ app, ...selected.connection, ownerId: "user_fixture", repository: null, orchestrator: null,
    executionRoots: null, collaboration: null, bots: { slackThreadContext: { receive } } as never });
  try {
    const path = "/api/internal/slack/context", body = JSON.stringify({ ...access, event: { appId: "A123", teamId: "T123", channelId: "C123", eventId: "Ev123", ts: "1795000001.000001", threadTs: "1795000000.000001", userId: "U123", text: "ordinary fixture" } });
    expect((await app.request(path, { method: "POST", body, headers: await signSlackBridgeRequest({ token: preview.MATRIX_SLACK_PLATFORM_TOKEN, path, body }) })).status).toBe(202);
    expect((await app.request(path, { method: "POST", body, headers: await signSlackBridgeRequest({ token: core.UPGRADE_TOKEN, path, body }) })).status).toBe(401);
    expect(receive).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

const devTarget = {
  ownerId: "user_fixture", machineId: core.MATRIX_MACHINE_ID, handle: "fixture-dev",
  appId: "A123", teamId: "T123", channelId: "C123", botId: "bot_12345678", chatId: "chat_fixture",
};
const dev = {
  ...core, MATRIX_USER_ID: devTarget.ownerId, MATRIX_HANDLE: devTarget.handle, MATRIX_RUNTIME_SLOT: "dev", MATRIX_PREVIEW_RUNTIME: "false",
  MATRIX_SLACK_DEV_TARGET: JSON.stringify(devTarget), MATRIX_SLACK_PLATFORM_TOKEN: "d".repeat(64),
  MATRIX_SLACK_PLATFORM_URL: "https://slack-dev-11111111---matrix-platform-preview-fixture-ey.a.run.app",
};
it("selects the dedicated Slack transport only for the exact opted-in Dev computer", () => {
  const selected = resolveSlackPlatform(dev);
  expect(selected.connection).toEqual({
    devTarget, platformUrl: dev.MATRIX_SLACK_PLATFORM_URL, token: dev.MATRIX_SLACK_PLATFORM_TOKEN, handle: devTarget.handle,
  });
  expect(selected.botConnection).toMatchObject({ ...selected.connection, machineId: devTarget.machineId, runtimeSlot: "dev" });
});
it.each([
  { MATRIX_SLACK_DEV_TARGET: "" }, { MATRIX_SLACK_DEV_TARGET: "bad json" },
  { MATRIX_SLACK_DEV_TARGET: JSON.stringify({ ...devTarget, extra: "not accepted" }) },
  { MATRIX_SLACK_DEV_TARGET: JSON.stringify({ ...devTarget, chatId: "" }) },
  { MATRIX_USER_ID: "user_other" }, { MATRIX_HANDLE: "other-dev" }, { MATRIX_RUNTIME_SLOT: "primary" },
  { MATRIX_MACHINE_ID: "aaaaaaaa-2222-4333-8444-555555555555" }, { MATRIX_PREVIEW_RUNTIME: "true" },
  { MATRIX_SLACK_PLATFORM_URL: preview.MATRIX_SLACK_PLATFORM_URL },
  { MATRIX_SLACK_PLATFORM_URL: dev.MATRIX_SLACK_PLATFORM_URL.replace("11111111", "22222222") },
  { MATRIX_SLACK_PLATFORM_URL: dev.MATRIX_SLACK_PLATFORM_URL + "/path" },
  { MATRIX_SLACK_PLATFORM_TOKEN: undefined }, { MATRIX_SLACK_PLATFORM_TOKEN: core.UPGRADE_TOKEN },
])("rejects invalid Dev opt-in without using core transport: %j", patch => {
  expect(resolveSlackPlatform({ ...dev, ...patch })).toEqual({ connection: undefined, botConnection: null });
});
it("blocks signed Slack ingress outside the exact private Dev Chat and accepts the existing signed read-only context", async () => {
  const selected = resolveSlackPlatform(dev);
  const app = new Hono(), receive = vi.fn(async () => true);
  const runtime = await startOwnerSlack({ app, ...selected.connection, ownerId: devTarget.ownerId, repository: null, orchestrator: null,
    executionRoots: null, collaboration: null, bots: { slackThreadContext: { receive } } as never });
  const envelope = { ownerId: devTarget.ownerId, botId: devTarget.botId, chatId: devTarget.chatId, runtimeId: devTarget.machineId,
    grantId: "b".repeat(64), event: { appId: devTarget.appId, teamId: devTarget.teamId, channelId: devTarget.channelId,
      eventId: "Ev123", ts: "1795000001.000001", threadTs: "1795000000.000001", userId: "U123", text: "ordinary fixture" } };
  const source = { version: 1 as const, ownerMention: false, textDigest: "1".repeat(64), proof: "2".repeat(64) };
  const contextPath = "/api/internal/slack/context";
  async function post(path: string, payload: unknown, token = dev.MATRIX_SLACK_PLATFORM_TOKEN, attest = false) {
    const body = JSON.stringify(payload);
    const headers = await signSlackBridgeRequest({ token, path, body });
    const extension = attest
      ? await signSlackContextSource({ token, path, body, timestamp: headers["x-matrix-slack-timestamp"], source }) : {};
    return app.request(path, { method: "POST", body, headers: { ...headers, ...extension } });
  }
  try {
    expect((await post(contextPath, envelope, core.UPGRADE_TOKEN, true)).status).toBe(401);
    expect((await post(contextPath, envelope)).status).toBe(403);
    for (const payload of [
      { ...envelope, ownerId: "user_other" }, { ...envelope, chatId: "chat_other" }, { ...envelope, botId: "bot_87654321" },
      { ...envelope, runtimeId: "other_runtime" }, { ...envelope, event: { ...envelope.event, appId: "A124" } },
      { ...envelope, event: { ...envelope.event, teamId: "T124" } }, { ...envelope, event: { ...envelope.event, channelId: "C124" } },
    ]) expect((await post(contextPath, payload, undefined, true)).status).toBe(403);
    const legacySummary = { ruleId: "legacy_rule", version: 1, proof: "1".repeat(64) };
    expect((await post(contextPath, { ...envelope, summary: legacySummary }, undefined, true)).status).toBe(403);
    expect((await post("/api/internal/slack/events", {})).status).toBe(403);
    expect((await post("/api/internal/slack/authorize", {})).status).toBe(403);
    expect((await post(contextPath, envelope, undefined, true)).status).toBe(202);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ ...envelope, source });
  } finally { await runtime.close(); }
});

import { startBots } from "../../packages/gateway/src/startup/bots.js";
import { createRealBotStateDatabase, OWNER, BOT } from "./bots/bot-state-support.js";
import { requestFixture } from "./bots/routine-cli-request-support.js";
import type { SlackBotPlatform } from "../../packages/gateway/src/startup/slack-platform.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function startBotFixture(slackPlatform: SlackBotPlatform | null | undefined, coreConfigured = true, computerId = core.MATRIX_HANDLE) {
  const data = await createRealBotStateDatabase(); cleanups.push(data.destroy);
  const f = await requestFixture(data.db, { recipeRef: { recipeId: "personal-assistant", version: "2026-09-30.1" } }); cleanups.push(f.close);
  const platform = { platformUrl: core.PLATFORM_INTERNAL_URL, token: core.UPGRADE_TOKEN, handle: computerId,
    machineId: core.MATRIX_MACHINE_ID, runtimeSlot: computerId === core.MATRIX_HANDLE ? core.MATRIX_RUNTIME_SLOT : "dev" };
  const services = await startBots({ homePath: f.home, repository: f.chats, agents: f.agents, runtimeOwnerId: OWNER,
    computerId, configuredOwnerIds: [OWNER], executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    host: { available: true, client: {}, registerAuthorizer: vi.fn(() => vi.fn()) } as never,
    ...(coreConfigured ? { routineActionPlatform: platform } : {}), ...(slackPlatform === undefined ? {} : { slackPlatform }) });
  if (!services) throw new Error("Actual bot startup required"); cleanups.push(services.close);
  return { services, data };
}
it("wires actual bot context and rule/read service startup to the isolated pair while core routine transport stays configured", async () => {
  const calls: Array<{ url: string; token: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ url: String(url), token: new Headers(init?.headers).get("authorization") });
    return Response.json({ allowed: true, channel: { id: "C123", name: "tech" } });
  }));
  const { services, data } = await startBotFixture(resolveSlackPlatform(preview).botConnection);
  expect(services.routineOrigin).toBeDefined(); expect(services.slackMentionSummaries).toBeDefined();
  expect(services.slackThreadContext).toBeDefined();
  const target = { ownerId: OWNER, botId: BOT, chatId: "chat_target_a", runtimeId: core.MATRIX_MACHINE_ID, grantId: "d".repeat(64) };
  expect(await services.slackThreadContext!.receive({ ...target, event: { appId: "A123", teamId: "T123", channelId: "C123", eventId: "EvStartup", ts: "1795000001.000001", threadTs: "1795000000.000001", userId: "U123", text: "ordinary startup fixture" } })).toBe(true);
  expect(await services.slackThreadContext!.prompt({ ...target, signal: AbortSignal.timeout(5000) })).toContain("ordinary startup fixture");
  expect(calls).toEqual([{ url: preview.MATRIX_SLACK_PLATFORM_URL + "/internal/slack/thread-context/access", token: `Bearer ${preview.MATRIX_SLACK_PLATFORM_TOKEN}` }]);
  expect(await data.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
});
it("starts the private Slack read and rule services on the actual pinned Dev bot runtime", async () => {
  const target = { ...devTarget, ownerId: OWNER, botId: BOT, chatId: "chat_target_a" };
  const selected = resolveSlackPlatform({ ...dev, MATRIX_USER_ID: OWNER, MATRIX_SLACK_DEV_TARGET: JSON.stringify(target) });
  const observe = vi.spyOn(integrationToolsModule, "createBotIntegrationTools");
  const calls: Array<{ url: string; token: string | null; handle: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), token: headers.get("authorization"), handle: headers.get("x-matrix-handle") });
    const channel = { id: target.channelId, name: "tech" };
    return String(url).endsWith("/enrollment")
      ? Response.json({ available: true, access: { ...JSON.parse(String(init?.body)), grantId: "f".repeat(64) },
        appId: target.appId, teamId: target.teamId, channelId: target.channelId, scope: "channel", channel })
      : Response.json({ allowed: true, channel });
  }));
  const { services, data } = await startBotFixture(selected.botConnection, true, target.handle);
  expect(services.routineOrigin).toBeDefined();
  expect(services.routineOriginMachine).toEqual({ handle: target.handle, machineId: target.machineId, runtimeSlot: "dev" });
  expect(services.slackMentionSummaries).toBeDefined();
  const slackContext = services.slackThreadContext;
  expect(slackContext).toBeDefined();
  const access = { ownerId: OWNER, botId: BOT, chatId: target.chatId, runtimeId: target.machineId, grantId: "f".repeat(64) };
  const event = { appId: target.appId, teamId: target.teamId, channelId: target.channelId, eventId: "EvDevStartup",
    ts: "1795000001.000001", threadTs: "1795000000.000001", userId: "U123", text: "Dev #tech fixture" };
  const source = { version: 1 as const, ownerMention: false, textDigest: createHash("sha256").update(event.text).digest("hex"), proof: "b".repeat(64) };
  expect(await slackContext!.receive({ ...access, event, source })).toBe(true);
  expect(await slackContext!.prompt({ ...access, signal: AbortSignal.timeout(5000) })).toContain(event.text);
  expect(observe).toHaveBeenCalledOnce();
  const inventory = await observe.mock.results[0]!.value.inventory({ ...access, requestClass: "interactive" } as never,
    { service: "slack" }, AbortSignal.timeout(5000));
  expect(JSON.stringify(inventory)).toContain("#tech");
  expect(calls).toEqual(["access", "enrollment"].map(route => ({
    url: `${dev.MATRIX_SLACK_PLATFORM_URL}/internal/slack/thread-context/${route}`,
    token: `Bearer ${dev.MATRIX_SLACK_PLATFORM_TOKEN}`, handle: target.handle,
  })));
  expect(await data.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
});

it("keeps real bot startup available but Slack disabled for explicit null rather than falling through to routine transport", async () => {
  const { services } = await startBotFixture(null);
  expect(services.routineOrigin).toBeDefined(); expect(services.slackThreadContext).toBeUndefined(); expect(services.slackMentionSummaries).toBeUndefined();
});

it("accepts another matching own PR tag without hardcoding the pilot number", () => {
  expect(resolveSlackPlatform({ ...preview, MATRIX_HANDLE: "pr-2117", MATRIX_RUNTIME_SLOT: "pr-2117",
    MATRIX_SLACK_PLATFORM_URL: "https://pr-2117---matrix-platform-preview-fixture-ey.a.run.app" }).connection?.handle).toBe("pr-2117");
});
it("preserves actual legacy bot startup when its dedicated Slack option is omitted", async () => {
  const { services } = await startBotFixture(undefined);
  expect(services.slackThreadContext).toBeDefined(); expect(services.slackMentionSummaries).toBeDefined();
});
it("mounts an unavailable receiver for an invalid override even with core credentials and an existing bot context", async () => {
  const selected = resolveSlackPlatform({ ...preview, MATRIX_SLACK_PLATFORM_TOKEN: undefined });
  const app = new Hono(), receive = vi.fn(async () => true);
  const runtime = await startOwnerSlack({ app, ...selected.connection, ownerId: "user_fixture", repository: null, orchestrator: null,
    executionRoots: null, collaboration: null, bots: { slackThreadContext: { receive } } as never });
  try {
    const path = "/api/internal/slack/context", body = "{}";
    expect((await app.request(path, { method: "POST", body, headers: await signSlackBridgeRequest({ token: core.UPGRADE_TOKEN, path, body }) })).status).toBe(503);
    expect(receive).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});


import * as integrationToolsModule from "../../packages/gateway/src/bots/integration-tools.js";
afterEach(() => vi.restoreAllMocks());
it("retains the actual generic integration inventory fallback when Slack is null but core Preview transport exists", async () => {
  const observe = vi.spyOn(integrationToolsModule, "createBotIntegrationTools");
  await startBotFixture(null);
  expect(observe).toHaveBeenCalledOnce();
  const actualTools = observe.mock.results[0]!.value;
  await expect(actualTools.inventory({ ownerId: OWNER, botId: BOT, chatId: "chat_target_a", requestClass: "interactive" } as never,
    { service: "slack" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
});
it("exposes actual enrolled native inventory with Slack-only composition and no core transport", async () => {
  const observe = vi.spyOn(integrationToolsModule, "createBotIntegrationTools");
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).endsWith("/enrollment")
    ? Response.json({available:true,access:{...JSON.parse(String(init?.body)),grantId:"d".repeat(64)},appId:"A123",teamId:"T123",channelId:"C123",scope:"channel",channel:{id:"C123",name:"tech"}})
    : Response.json({ allowed: true, channel: { id: "C123", name: "tech" } })));
  const { services } = await startBotFixture(resolveSlackPlatform(preview).botConnection, false);
  expect(services.routineOrigin).toBeUndefined();
  const target = { ownerId: OWNER, botId: BOT, chatId: "chat_target_a", runtimeId: core.MATRIX_MACHINE_ID, grantId: "d".repeat(64) };
  expect(await services.slackThreadContext!.receive({ ...target, event: { appId: "A123", teamId: "T123", channelId: "C123", eventId: "EvInventory", ts: "1795000001.000001", threadTs: "1795000000.000001", userId: "U123", text: "inventory fixture" } })).toBe(true);
  expect(observe).toHaveBeenCalledOnce();
  const result = await observe.mock.results[0]!.value.inventory({ ...target, requestClass: "interactive" } as never,
    { service: "slack" }, AbortSignal.timeout(5000));
  expect(JSON.stringify(result)).toContain("slack_enrolled_"); expect(JSON.stringify(result)).toContain("#tech");
});
it("preserves legacy opaque runtime identifiers when the override pair is absent", () => {
  expect(resolveSlackPlatform({ ...core, MATRIX_MACHINE_ID: "legacy_opaque_runtime" }).botConnection?.machineId).toBe("legacy_opaque_runtime");
});
