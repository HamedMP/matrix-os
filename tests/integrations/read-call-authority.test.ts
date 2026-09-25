import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";

describe("owner-bound integration read-call authority", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: PlatformDb;
  let app: Hono;
  let ownerId: string;
  let provider: PipedreamConnectClient;
  const proxyGet = vi.fn(async () => ({ labels: [] }));
  const proxyPost = vi.fn(async () => ({ results: [] }));

  beforeEach(async () => {
    proxyGet.mockClear();
    proxyPost.mockClear();
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    const owner = await db.createUser({
      clerkId: "owner_read_call", handle: "readcall", displayName: "Read Call", email: "read@example.invalid",
      containerId: "container_read_call", pipedreamExternalId: "pd_read_call",
    });
    ownerId = owner.id;
    provider = {
      getAppInfo: vi.fn(async () => null),
      listAccounts: vi.fn(async () => []),
      proxyGet,
      proxyPost,
    } as unknown as PipedreamConnectClient;
    app = new Hono();
    app.route("/api/integrations", createIntegrationRoutes({
      db, pipedream: provider, webhookSecret: "test-only-webhook-secret",
      resolveUserId: async () => ownerId,
    }));
  });

  afterEach(async () => { await db.destroy(); });

  function readCall(body: unknown): Promise<Response> {
    return app.request("/api/integrations/read-call", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("calls an explicit read action on the selected owner's exact account, but never a write action", async () => {
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_work",
      accountLabel: "Work", scopes: ["read"] });
    const other = await db.createUser({ clerkId: "other_read_call", handle: "otherread", displayName: "Other",
      email: "other@example.invalid", containerId: "container_other", pipedreamExternalId: "pd_other" });
    await db.connectService({ userId: other.id, service: "gmail", pipedreamAccountId: "pd_other",
      accountLabel: "Work", scopes: ["read"] });

    const read = await readCall({ service: "gmail", action: "list_labels", label: "Work", params: {} });
    expect(read.status).toBe(200);
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "pd_work" }));
    expect(proxyGet).toHaveBeenCalledTimes(1);

    const write = await readCall({ service: "gmail", action: "send_email", label: "Work",
      params: { to: "recipient@example.invalid", subject: "Test", body: "Test" } });
    expect(write.status).toBe(403);
    expect(proxyPost).not.toHaveBeenCalled();
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });

  it("allows a registry-declared read even when the provider operation uses POST", async () => {
    await db.connectService({ userId: ownerId, service: "notion", pipedreamAccountId: "pd_notion",
      accountLabel: "Research", scopes: ["read"] });
    const result = await readCall({ service: "notion", action: "search", label: "Research", params: {} });
    expect(result.status).toBe(200);
    expect(proxyPost).toHaveBeenCalledWith(expect.objectContaining({ accountId: "pd_notion" }));
  });

  it("requires one exact label and rejects duplicate matches before reaching the provider", async () => {
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_first",
      accountLabel: "Shared", scopes: ["read"] });
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_second",
      accountLabel: "Shared", scopes: ["read"] });

    expect((await readCall({ service: "gmail", action: "list_labels", params: {} })).status).toBe(400);
    expect((await readCall({ service: "gmail", action: "list_labels", label: "Shared", params: {} })).status).toBe(409);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("fails closed for unknown actions and malformed account labels", async () => {
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_work",
      accountLabel: "Work", scopes: ["read"] });
    expect((await readCall({ service: "gmail", action: "not_registered", label: "Work", params: {} })).status).toBe(400);
    expect((await readCall({ service: "gmail", action: "list_labels", label: "   ", params: {} })).status).toBe(400);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("fails closed when reviewed risk metadata is absent and when a preset cannot select the exact account", async () => {
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_work",
      accountLabel: "Work", scopes: ["read"] });
    const action = getAction("gmail", "list_labels")!;
    const originalRisk = action.risk;
    try {
      action.risk = undefined as never;
      expect((await readCall({ service: "gmail", action: "list_labels", label: "Work", params: {} })).status).toBe(403);
    } finally {
      action.risk = originalRisk;
    }
    expect((await readCall({ service: "granola", action: "list_folders", label: "Work", params: {} })).status).toBe(403);
    expect(proxyGet).not.toHaveBeenCalled();
    expect(proxyPost).not.toHaveBeenCalled();
  });

  it("rejects oversized scoped calls before parsing or provider invocation", async () => {
    const res = await readCall({ service: "gmail", action: "list_labels", label: "Work",
      params: { huge: "x".repeat(70_000) } });
    expect(res.status).toBe(413);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("updates selected connection usage only after a successful scoped read", async () => {
    await db.connectService({ userId: ownerId, service: "gmail", pipedreamAccountId: "pd_work",
      accountLabel: "Work", scopes: ["read"] });
    expect((await db.listConnectedServices(ownerId))[0]?.last_used_at).toBeNull();
    expect((await readCall({ service: "gmail", action: "list_labels", label: "Work", params: {} })).status).toBe(200);
    expect((await db.listConnectedServices(ownerId))[0]?.last_used_at).not.toBeNull();
  });

  it.each([
    [{ errors: [{ message: "secret provider error", extensions: { code: "UNAUTHENTICATED" } }] }, 422, "configuration_error"],
    [{ errors: [{ message: "secret provider error", extensions: { code: "RATELIMITED" } }] }, 429, "rate_limited"],
    [{ errors: [{ message: "secret provider error", extensions: { code: "INTERNAL_ERROR" } }] }, 503, "transient_failure"],
    [{ errors: [{ message: "secret provider error", extensions: { code: "BAD_USER_INPUT" } }] }, 200, "OPERATION_FAILED"],
  ] as const)("classifies Linear GraphQL read failures before success and usage (%s)", async (providerBody, status, code) => {
    await db.connectService({ userId: ownerId, service: "linear", pipedreamAccountId: "pd_linear",
      accountLabel: "Work", scopes: ["read"] });
    proxyPost.mockResolvedValueOnce(providerBody as never);
    const result = await readCall({ service: "linear", action: "symphony_viewer", label: "Work", params: {} });
    expect(result.status).toBe(status);
    const text = await result.text();
    expect(text).toContain(code);
    expect(text).not.toContain("secret provider error");
    expect((await db.listConnectedServices(ownerId))[0]?.last_used_at).toBeNull();
  });

  it.each([
    [{ statusCode: 400, body: { errors: [{ extensions: { code: "RATELIMITED" } }] } }, 429, "rate_limited"],
    [{ statusCode: 401 }, 422, "provider_rejected"],
    [{ statusCode: 429, headers: { "retry-after": "17" } }, 429, "retry_after"],
  ] as const)("preserves Linear provider rejection classification (%s)", async (upstream, status, code) => {
    await db.connectService({ userId: ownerId, service: "linear", pipedreamAccountId: "pd_linear",
      accountLabel: "Work", scopes: ["read"] });
    proxyPost.mockRejectedValueOnce(upstream);
    const result = await readCall({ service: "linear", action: "symphony_viewer", label: "Work", params: {} });
    expect(result.status).toBe(status);
    expect(await result.text()).toContain(code);
    expect((await db.listConnectedServices(ownerId))[0]?.last_used_at).toBeNull();
  });
});
