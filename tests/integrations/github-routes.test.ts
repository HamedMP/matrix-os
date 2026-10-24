import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createTestIntegrationDb } from "./native-integration-db-test-helper.js";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION = {
  id: CONNECTION_ID,
  service: "github",
  account_label: "Work",
  account_email: null,
  scopes: ["repo", "notifications"],
  status: "active",
  connected_at: "2026-10-24T02:00:00.000Z",
  last_used_at: null,
};

function pipedream(): PipedreamConnectClient {
  return {
    createConnectToken: vi.fn(),
    getOAuthUrl: vi.fn(),
    callAction: vi.fn(),
    discoverActions: vi.fn(async () => []),
    runAction: vi.fn(),
    revokeAccount: vi.fn(),
    listAccounts: vi.fn(async () => []),
    getAppInfo: vi.fn(async () => null),
    proxyGet: vi.fn(),
    proxyPost: vi.fn(),
  } as unknown as PipedreamConnectClient;
}

function githubBroker() {
  return {
    start: vi.fn(() => "https://github.com/login/oauth/authorize?state=opaque"),
    resolveRedirectTarget: vi.fn(() => "web" as const),
    complete: vi.fn(async () => ({ redirectTarget: "web" as const, connection: CONNECTION })),
    listConnections: vi.fn(async () => [CONNECTION]),
    call: vi.fn(async () => ({ data: { repositories: [] } })),
    disconnect: vi.fn(async () => true),
    rename: vi.fn(async () => ({ ...CONNECTION, account_label: "Personal" })),
    refreshConnection: vi.fn(async () => CONNECTION),
  };
}

describe("Matrix-owned GitHub integration routes", () => {
  let db: PlatformDb;
  let userId: string;
  let provider: ReturnType<typeof pipedream>;
  let broker: ReturnType<typeof githubBroker>;
  let app: Hono;

  beforeEach(async () => {
    ({ db } = await createTestIntegrationDb());
    userId = (await db.createUser({
      clerkId: "github-route-owner",
      handle: "github-route-owner",
      displayName: "GitHub Route Owner",
      email: "owner@example.test",
      containerId: "github-route-owner-container",
    })).id;
    provider = pipedream();
    broker = githubBroker();
    const routes = createIntegrationRoutes({
      db,
      pipedream: provider,
      webhookSecret: "test-secret",
      resolveUserId: async () => userId,
      githubBroker: broker,
      githubCompletionUrls: {
        web: "https://app.matrix-os.com/integrations",
        mobile: "matrixos://integrations",
      },
    });
    app = new Hono().route("/api/integrations", routes);
  });

  afterEach(async () => db.destroy());

  it("starts GitHub consent through the native broker and preserves the fixed mobile target", async () => {
    const response = await app.request("/api/integrations/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "github", label: "Work", redirectUri: "matrixos://integrations" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "github",
      url: "https://github.com/login/oauth/authorize?state=opaque",
    });
    expect(broker.start).toHaveBeenCalledWith(userId, { label: "Work", redirectTarget: "mobile" });
    expect(provider.createConnectToken).not.toHaveBeenCalled();
  });

  it("completes the public callback and redirects only to the configured completion URL", async () => {
    const response = await app.request("/api/integrations/oauth/github/callback?state=opaque&code=code-1", {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://app.matrix-os.com/integrations?service=github&status=connected",
    );
    expect(broker.complete).toHaveBeenCalledWith("opaque", "code-1");
  });

  it("redirects provider denial to the state-bound target without exposing provider details", async () => {
    broker.resolveRedirectTarget.mockReturnValueOnce("mobile");
    const response = await app.request(
      "/api/integrations/oauth/github/callback?state=opaque&error=access_denied&error_description=private-provider-detail",
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("matrixos://integrations?service=github&status=error");
    expect(broker.complete).not.toHaveBeenCalled();
  });

  it("rejects oversized callback fields before decrypting state or contacting GitHub", async () => {
    const response = await app.request(
      `/api/integrations/oauth/github/callback?state=${"s".repeat(8_193)}&code=${"c".repeat(513)}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid authorization response" });
    expect(broker.resolveRedirectTarget).not.toHaveBeenCalled();
    expect(broker.complete).not.toHaveBeenCalled();
  });

  it("lists only the native GitHub row when a legacy Pipedream row remains", async () => {
    await db.connectService({
      userId,
      service: "github",
      pipedreamAccountId: "legacy-github",
      accountLabel: "Legacy",
      scopes: ["repo"],
    });

    const response = await app.request("/api/integrations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([CONNECTION]);
  });

  it("dispatches normal and scoped GitHub reads through the native broker", async () => {
    const call = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "github", action: "list_repos", label: "Work", params: {} }),
    });
    const read = await app.request("/api/integrations/read-call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "github", action: "list_repos", label: "Work", params: {} }),
    });

    expect(call.status).toBe(200);
    expect(read.status).toBe(200);
    expect(broker.call).toHaveBeenCalledTimes(2);
    expect(broker.call).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      connectionId: CONNECTION_ID,
      action: expect.objectContaining({ description: "List repositories" }),
    }));
    expect(provider.proxyGet).not.toHaveBeenCalled();
  });

  it("serves native status, rename, refresh, and disconnect lifecycle routes", async () => {
    const status = await app.request(`/api/integrations/${CONNECTION_ID}/status`);
    const rename = await app.request(`/api/integrations/${CONNECTION_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Personal" }),
    });
    const refresh = await app.request(`/api/integrations/${CONNECTION_ID}/refresh`, { method: "POST" });
    const disconnect = await app.request(`/api/integrations/${CONNECTION_ID}`, { method: "DELETE" });

    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ id: CONNECTION_ID, service: "github", status: "active" });
    expect(rename.status).toBe(200);
    expect(broker.rename).toHaveBeenCalledWith(userId, CONNECTION_ID, "Personal");
    expect(refresh.status).toBe(200);
    expect(broker.refreshConnection).toHaveBeenCalledWith(userId, CONNECTION_ID);
    expect(disconnect.status).toBe(200);
    expect(broker.disconnect).toHaveBeenCalledWith(userId, CONNECTION_ID);
    expect(provider.revokeAccount).not.toHaveBeenCalled();
  });
});
