import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { callServiceHandler, describeServiceHandler, type GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

const serverId = "123456789012345678";
const channelId = "234567890123456789";

describe("Discord discovery through owner gateway and agent tools (synthetic provider)", () => {
  let db: PlatformDb;
  let userId: string;
  let app: Hono;
  let pipedream: PipedreamConnectClient;
  let fetcher: GatewayFetcher;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pg.dialect });
    await db.migrate();
    const user = await db.createUser({ clerkId: "discord-owner", handle: "discord-owner", displayName: "Owner", email: "owner@example.com", containerId: "discord-test", pipedreamExternalId: "pd_owner" });
    userId = user.id;
    pipedream = {
      createConnectToken: vi.fn().mockResolvedValue({ token: "test", expiresAt: "2099-01-01", connectLinkUrl: "https://pipedream.com/connect/test" }),
      getOAuthUrl: vi.fn().mockImplementation((url, slug) => `${url}?app=${slug}`),
      callAction: vi.fn(), revokeAccount: vi.fn(), discoverActions: vi.fn().mockResolvedValue([]), runAction: vi.fn(),
      listAccounts: vi.fn().mockResolvedValue([]), getAppInfo: vi.fn().mockResolvedValue(null),
      proxyGet: vi.fn().mockResolvedValue([]), proxyPost: vi.fn(), proxyPut: vi.fn(), proxyPatch: vi.fn(), proxyDelete: vi.fn(),
    };
    app = new Hono();
    app.route("/api/integrations", createIntegrationRoutes({ db, pipedream, webhookSecret: "test", resolveUserId: async () => userId }));
    fetcher = (url, init) => app.request(new URL(url).pathname, init);
  });
  afterEach(async () => { await db.destroy(); });
  const paramsFor = (action: string) => action === "list_channels" ? { serverId } : { channelId, ...(action === "send_message" ? { content: "Synthetic" } : {}) };
  function call(service: string, action: string, params = paramsFor(action), path = "call", label = "Work", connectionId?: string) {
    return app.request(`/api/integrations/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service, action, params, label, ...(connectionId ? { connectionId } : {}) }) });
  }

  it.each([{ scopes: [] }, { scopes: ["identify", "guilds"] }, { scopes: ["guilds", "bot", "messages.read"] }])("blocks unsupported REST reads independently of local scope metadata $scopes", async ({ scopes }) => {
    await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes });
    const catalog = await (await app.request("/api/integrations/agent-catalog")).json();
    expect(Object.keys(catalog.find((service: { id: string }) => service.id === "discord").actions)).toEqual(["list_servers", "send_message"]);
    for (const path of ["call", "read-call"]) {
      for (const action of ["list_channels", "list_messages"]) {
        const response = await call("discord", action, paramsFor(action), path);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "discord_bot_required", required_service: "discord_bot" });
      }
    }
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
    expect(pipedream.runAction).not.toHaveBeenCalled();
    const result = await callServiceHandler({ service: "discord", action: "list_channels", params: { serverId }, label: "Work" }, fetcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Discord Bot");
    expect(result.content[0].text).toContain("Do not read messages");
  });
  it.each([{ scopes: [] }, { scopes: ["guilds"] }, { scopes: ["bot", "email", "identify", "guilds"] }])("allows lawful OAuth reads and managed Bot actions with local scopes $scopes", async ({ scopes }) => {
    await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes });
    vi.mocked(pipedream.proxyGet).mockResolvedValue([{ id: serverId }]);
    vi.mocked(pipedream.runAction).mockResolvedValue({ ret: { id: "345678901234567890" }, exports: {} });
    expect((await call("discord", "list_servers", {}, "read-call")).status).toBe(200);
    expect((await call("discord", "send_message")).status).toBe(200);
    expect(pipedream.runAction).toHaveBeenCalledExactlyOnceWith({ externalUserId: "pd_owner", componentKey: "discord-send-message",
      configuredProps: { discord: { authProvisionId: "oauth-account" }, channel: channelId, message: "Synthetic", includeSentViaPipedream: false } });
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
    expect((await call("discord", "send_message", paramsFor("send_message"), "read-call")).status).toBe(403);
    expect(pipedream.runAction).toHaveBeenCalledTimes(1);
  });
  it.each(["call", "read-call"])("distinguishes provider auth, permissions, throttling and downtime on /%s", async (path) => {
    const row = await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "bot-account", accountLabel: "Work", scopes: [] });
    for (const [upstream, expected, code] of [[401, 401, "integration_authorization_required"], [403, 403, "discord_access_denied"], [429, 429, undefined], [500, 502, undefined]] as const) {
      vi.mocked(pipedream.proxyGet).mockRejectedValueOnce({ statusCode: upstream, message: "token=PRIVATE /secret/channel", rawResponse: new Response("private body", { status: upstream, headers: { "retry-after": "12" } }) });
      const response = await call("discord_bot", "list_channels", { serverId }, path);
      expect(response.status).toBe(expected);
      const body = await response.json();
      expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE|secret|private body/);
      if (upstream === 429) expect(response.headers.get("retry-after")).toBe("12");
    }
    expect((await db.getConnectedService(row.id))?.last_used_at).toBeNull();
    expect(pipedream.proxyGet).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/messages") }));
  });

  it("presents authorization failures as agent errors and stops the discovery flow", async () => {
    await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "bot-account", accountLabel: "Work", scopes: [] });
    vi.mocked(pipedream.proxyGet).mockRejectedValueOnce({ status: 401 });
    const result = await callServiceHandler({ service: "discord_bot", action: "list_channels", params: { serverId }, label: "Work" }, fetcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Reconnect");
    expect(result.content[0].text).toContain("Do not read messages");
    expect(result.content[0].text).not.toContain("temporarily unavailable");
  });

  it.each(["call", "read-call"])("keeps server → channel → message evidence on the selected bot account via /%s", async (path) => {
    await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes: ["guilds"] });
    await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "other-bot", accountLabel: "Personal", scopes: [] });
    const bot = await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "work-bot", accountLabel: "Work", scopes: [] });
    vi.mocked(pipedream.proxyGet).mockImplementation(async (request) => {
      expect(request.externalUserId).toBe("pd_owner");
      expect(request.accountId).toBe("work-bot");
      if (request.url.endsWith("/users/@me/guilds")) return [{ id: serverId }, { id: "345678901234567890" }];
      if (request.url.endsWith(`/guilds/${serverId}/channels`)) return [{ id: channelId, type: 0 }];
      if (request.url.endsWith(`/channels/${channelId}/messages`)) return [{ id: "456789012345678901", content: "Synthetic release scheduled for Friday." }];
      throw new Error("Unexpected synthetic provider URL");
    });
    const servers = await call("discord_bot", "list_servers", {}, path);
    expect(servers.status).toBe(200);
    const server = (await servers.json()).data[0];
    const channels = await call("discord_bot", "list_channels", { serverId: server.id }, path);
    expect(channels.status).toBe(200);
    const channel = (await channels.json()).data[0];
    const messages = await call("discord_bot", "list_messages", { channelId: channel.id }, path);
    expect(messages.status).toBe(200);
    expect((await messages.json()).data[0].content).toBe("Synthetic release scheduled for Friday.");
    expect((await db.getConnectedService(bot.id))?.last_used_at).not.toBeNull();
    const description = await describeServiceHandler({ service: "discord_bot" }, fetcher);
    expect(description.content[0].text).toContain("list_channels [read]");
    const evidence = await callServiceHandler({ service: "discord_bot", action: "list_messages", params: { channelId }, label: "Work" }, fetcher);
    expect(evidence.isError).toBeUndefined();
    expect(evidence.content[0].text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(evidence.content[0].text).toContain("Synthetic release scheduled for Friday.");
  });

  it("preserves server listing for regular OAuth and returns empty bot channels honestly", async () => {
    await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes: ["guilds"] });
    await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "bot-account", accountLabel: "Work", scopes: [] });
    vi.mocked(pipedream.proxyGet).mockResolvedValueOnce([{ id: serverId }, { id: "345678901234567890" }]);
    const response = await call("discord", "list_servers", {});
    expect((await response.json()).data).toHaveLength(2);
    expect(pipedream.proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "oauth-account" }));
    const channels = await call("discord_bot", "list_channels", { serverId });
    expect(channels.status).toBe(200);
    expect((await channels.json()).data).toEqual([]);
    expect(pipedream.proxyGet).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/messages") }));
  });

  it("never falls back to OAuth, another owner, an ambiguous label or a different grant", async () => {
    await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes: ["guilds"] });
    const bot = await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "bot-account", accountLabel: "Work", scopes: [] });
    expect((await call("discord_bot", "list_channels", { serverId }, "read-call", "Work", "different-grant")).status).toBe(403);
    await db.updateServiceStatus(bot.id, "expired");
    expect((await call("discord_bot", "list_channels", { serverId }, "read-call")).status).toBe(400);
    await db.updateServiceStatus(bot.id, "revoked");
    expect((await call("discord_bot", "list_channels", { serverId })).status).toBe(404);
    await db.updateServiceStatus(bot.id, "active");
    await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "duplicate-bot", accountLabel: "Work", scopes: [] });
    expect((await call("discord_bot", "list_channels", { serverId })).status).toBe(409);
    const other = await db.createUser({ clerkId: "other", handle: "other", displayName: "Other", email: "other@example.com", containerId: "other", pipedreamExternalId: "pd_other" });
    userId = other.id;
    expect((await call("discord_bot", "list_channels", { serverId }, "read-call")).status).toBe(400);
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
  });

  it("starts the separate bot credential flow without changing an existing OAuth connection", async () => {
    const oauth = await db.connectService({ userId, service: "discord", pipedreamAccountId: "oauth-account", accountLabel: "Work", scopes: [] });
    const catalog = await (await app.request("/api/integrations/available")).json();
    expect(catalog.find((service: { id: string }) => service.id === "discord_bot")).toMatchObject({ authType: "keys", pipedreamApp: "discord_bot" });
    const response = await app.request("/api/integrations/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "discord_bot", label: "Work" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("app=discord_bot");
    expect((await db.getConnectedService(oauth.id))?.status).toBe("active");
  });

  it("explains the OAuth limitation during agent discovery", async () => {
    const description = await describeServiceHandler({ service: "discord" }, fetcher);
    expect(description.content[0].text).toContain("list_servers");
    expect(description.content[0].text).toContain("send_message");
    expect(description.content[0].text).not.toContain("list_channels");
    expect(description.content[0].text).toContain("Pipedream's official Discord Bot");
    expect(description.content[0].text).toContain("direct channel/history reads");
  });

  it("ignores arbitrary gateway failure text and marks transport failures as errors", async () => {
    const input = { service: "discord_bot", action: "list_channels", params: { serverId }, label: "Work" };
    const unsafeFetcher: GatewayFetcher = async () => new Response(JSON.stringify({ code: "unknown", error: "token=PRIVATE /secret/channel" }), { status: 403 });
    const failure = await callServiceHandler(input, unsafeFetcher);
    expect(failure.isError).toBe(true);
    expect(failure.content[0].text).not.toMatch(/PRIVATE|secret/);
    expect(failure.content[0].text).toContain("Do not read messages");
    const networkFailure = await callServiceHandler(input, async () => { throw new Error("Synthetic network failure"); });
    expect(networkFailure.isError).toBe(true);
  });

  it.each([{ data: {} }, { data: [{ name: "Synthetic", id: "../invalid" }] }])("refuses malformed successful channel discovery %j", async ({ data }) => {
    await db.connectService({ userId, service: "discord_bot", pipedreamAccountId: "bot-account", accountLabel: "Work", scopes: [] });
    vi.mocked(pipedream.proxyGet).mockResolvedValueOnce(data);
    const result = await callServiceHandler({ service: "discord_bot", action: "list_channels", params: { serverId }, label: "Work" }, fetcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Do not read messages");
  });

});
