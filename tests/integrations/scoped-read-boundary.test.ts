import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { proxyIntegrationRequest } from "../../packages/gateway/src/integrations/platform-proxy.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { insertContainer } from "../../packages/platform/src/db.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../platform/platform-db-test-helper.js";

const platformSecret = "phase-a-platform-secret";
const handle = "read-owner";
const clerkOwner = "user_read_owner";

describe("scoped integration read across Gateway and Platform", () => {
  let integrationInstance: InstanceType<typeof KyselyPGlite>;
  let integrationDb: PlatformDb;
  let platformDb: Awaited<ReturnType<typeof createTestPlatformDb>>["db"];
  let gateway: Hono;
  let ownerId: string;
  let registry: ReturnType<typeof createMatrixMcpCapabilityRegistry>;
  let token: string;
  const providerGet = vi.fn(async () => ({ labels: [] }));
  const providerPost = vi.fn(async () => ({ results: [] }));

  beforeEach(async () => {
    providerGet.mockClear();
    providerPost.mockClear();
    integrationInstance = await KyselyPGlite.create();
    integrationDb = createPlatformDb({ dialect: integrationInstance.dialect });
    await integrationDb.migrate();
    const owner = await integrationDb.createUser({
      clerkId: clerkOwner, handle, displayName: "Read Owner", email: "read-owner@example.invalid",
      containerId: "container_read_owner", pipedreamExternalId: "pd_read_owner",
    });
    ownerId = owner.id;
    const other = await integrationDb.createUser({
      clerkId: "user_other", handle: "other", displayName: "Other", email: "other@example.invalid",
      containerId: "container_other", pipedreamExternalId: "pd_other",
    });
    await integrationDb.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_owner",
      accountLabel: "Work", scopes: ["read"] });
    await integrationDb.connectService({ userId: other.id, service: "gmail", pipedreamAccountId: "pd_other",
      accountLabel: "Other", scopes: ["read"] });
    ({ db: platformDb } = await createTestPlatformDb());
    await insertContainer(platformDb, { handle, clerkUserId: clerkOwner, port: 5001, shellPort: 6001, status: "running" });
    const routes = createIntegrationRoutes({
      db: integrationDb,
      pipedream: { getAppInfo: vi.fn(async () => null), listAccounts: vi.fn(async () => []),
        proxyGet: providerGet, proxyPost: providerPost } as never,
      webhookSecret: "fixture-webhook-secret",
      resolveUserId: async (c) => c.get("internalContainerClerkUserId") === clerkOwner ? ownerId : null,
    });
    const platform = createApp({ db: platformDb, orchestrator: {
      provision: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(),
      rollingRestart: vi.fn(), getInfo: vi.fn(), getImage: vi.fn(), listAll: vi.fn(() => []), syncStates: vi.fn(),
    } as never, platformSecret, internalIntegrationRoutes: routes });
    registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: clerkOwner });
    token = registry.issue({ owner: { type: "personal", ownerId: clerkOwner }, runId: "read_run", scope: "integration_read" as never })!.token;
    gateway = new Hono();
    gateway.use("*", authMiddleware("host-token", {
      resolveMatrixMcpCapability: registry.resolve,
      resolveMatrixMcpRunContext: registry.resolveRunContext,
    }));
    gateway.all("/api/integrations", (c) => proxyIntegrationRequest(c, {
      targetBase: `http://platform.test/internal/containers/${handle}/integrations`,
      machineToken: buildPlatformVerificationToken(handle, platformSecret),
      fetcher: (url, init) => platform.request(url, init),
    }));
    gateway.all("/api/integrations/*", (c) => proxyIntegrationRequest(c, {
      targetBase: `http://platform.test/internal/containers/${handle}/integrations`,
      machineToken: buildPlatformVerificationToken(handle, platformSecret),
      fetcher: (url, init) => platform.request(url, init),
    }));
  });

  afterEach(async () => {
    registry?.close();
    await integrationDb?.destroy();
    await destroyTestPlatformDb(platformDb);
  });

  function request(path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>) {
    return gateway.request(path, { method, headers: { authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  }

  it("signs the scoped actor for Platform, filters catalog writes, and calls only its selected account", async () => {
    const catalog = await request("/api/integrations/agent-catalog", "GET", undefined,
      { "x-matrix-integration-read-scope": "false" });
    expect(catalog.status).toBe(200);
    const services = await catalog.json() as Array<{ id: string; actions: Record<string, unknown> }>;
    const gmail = services.find((service) => service.id === "gmail")!;
    expect(gmail.actions.list_labels).toBeDefined();
    expect(gmail.actions.send_email).toBeUndefined();
    expect(services.find((service) => service.id === "granola")).toBeUndefined();

    const call = await request("/api/integrations/read-call", "POST",
      { service: "gmail", action: "list_labels", label: "Work", params: {} });
    expect(call.status).toBe(200);
    expect(providerGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "pd_owner" }));
    expect(providerGet).toHaveBeenCalledTimes(1);
    expect((await request("/api/integrations/call", "POST",
      { service: "gmail", action: "send_email", label: "Work", params: {} })).status).toBe(401);
    expect(providerPost).not.toHaveBeenCalled();
    expect((await request("/api/integrations/read-call", "POST", {
      service: "gmail", action: "list_labels", label: "Work", params: {}, readOnly: false,
    })).status).toBe(400);
  });

  it("rejects forged delegation, foreign account labels, and a revoked bearer before provider work", async () => {
    expect((await request("/api/integrations/read-call", "POST",
      { service: "gmail", action: "list_labels", label: "Work", params: {} },
      { "x-platform-user-id": "user_other", "x-platform-verified": "forged" })).status).toBe(401);
    expect((await request("/api/integrations/read-call", "POST",
      { service: "gmail", action: "list_labels", label: "Other", params: {} })).status).toBe(400);
    expect(providerGet).not.toHaveBeenCalled();
    registry.close();
    expect((await request("/api/integrations/agent-catalog")).status).toBe(401);
  });
});
