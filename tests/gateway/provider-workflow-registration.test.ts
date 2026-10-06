import { createHmac } from "node:crypto";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { getOptionalRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api.js";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerProviderWorkflowRuntime } from "../../packages/gateway/src/server/provider-workflow-runtime.js";

describe("provider workflow registration", () => {
  it("mounts the real service behind runtime-owner authorization and drains on shutdown", async () => {
    const app = new Hono();
    const cancel = vi.fn(async () => {});
    const start = vi.fn(async () => ({ cancel }));
    const lifecycle = await registerProviderWorkflowRuntime({ app, ownerId: "owner", getPrincipal: () => ({ userId: "owner" }),
      createAdapters: async () => [{ harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: [], install: false, uninstall: false, start }] });
    const response = await app.request("/api/ai/provider-settings/workflows", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex", kind: "login", method: "device_code", idempotencyKey: "start-1" }) });
    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledOnce();
    await lifecycle.close();
    expect(cancel).toHaveBeenCalledOnce();
    expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(503);
  });
  it("never starts native work for another owner or an anonymous request", async () => {
    const app = new Hono();
    let principal: { userId: string } | null = { userId: "other" };
    await registerProviderWorkflowRuntime({ app, ownerId: "owner", getPrincipal: () => principal, createAdapters: async () => [] });
    expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(403);
    principal = null;
    expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(401);
  });
  it("reports missing owner configuration as unavailable after authentication", async () => {
    const app = new Hono();
    const createAdapters = vi.fn();
    await registerProviderWorkflowRuntime({ app, ownerId: null, getPrincipal: () => ({ userId: "owner" }), createAdapters });
    expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(503);
    expect(createAdapters).not.toHaveBeenCalled();
  });
});


it("keeps signed Preview collaborators authenticated while denying every owner workflow", async () => {
  const app = new Hono();
  const token = "synthetic-preview-runtime-token";
  app.use("*", authMiddleware(token));
  const getPrincipal = (c: Parameters<typeof getOptionalRequestPrincipal>[0]) => getOptionalRequestPrincipal(c, {
    configuredUserId: "runtime_owner", isTrustedSingleUserGateway: true,
    authEnabled: true, isProduction: true, isLocalDevelopment: false,
  });
  const createAdapters = vi.fn(async () => []);
  const lifecycle = await registerProviderWorkflowRuntime({ app, ownerId: "runtime_owner", getPrincipal, createAdapters });
  app.get("/api/principal", c => c.json(getPrincipal(c)));
  const headers = {
    authorization: `Bearer ${token}`,
    "x-platform-user-id": "preview_collaborator",
    "x-platform-verified": createHmac("sha256", token).update("preview_collaborator").digest("hex"),
  };
  const root = "/api/ai/provider-settings/workflows";
  const requests = [
    { path: `${root}/capabilities`, method: "GET" },
    { path: `${root}/operation-1`, method: "GET" },
    { path: `${root}/logs/codex`, method: "GET" },
    { path: root, method: "POST", body: { harnessInstanceId: "codex", kind: "login", method: "device_code", idempotencyKey: "request-1" } },
    { path: `${root}/keys`, method: "POST", body: { harnessInstanceId: "codex", providerId: "openai", apiKey: "sk-synthetic-fixture" } },
    { path: `${root}/operation-1/cancel`, method: "POST", body: {} },
  ];
  try {
    expect(await (await app.request("/api/principal", { headers })).json()).toEqual({ userId: "preview_collaborator", source: "platform-verified" });
    for (const request of requests) {
      const response = await app.request(request.path, {
        method: request.method, headers: { ...headers, "content-type": "application/json" },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      expect(response.status, request.path).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: "forbidden", message: "This operation is unavailable. Refresh and try again." } });
    }
    const onUnauthorized = vi.fn();
    const client = createApiClient({ baseUrl: "https://runtime.test", getRuntimeSlot: () => "primary", onUnauthorized,
      fetchFn: async (input, init) => app.request(new URL(String(input)).pathname, { ...init, headers: { ...headers } }),
    });
    await expect(client.get(`${root}/capabilities`)).rejects.toMatchObject({ category: "unauthorized" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect((await app.request(`${root}/capabilities`)).status).toBe(401);
    expect((await app.request(`${root}/capabilities`, { headers: { ...headers, authorization: "Bearer invalid-token" } })).status).toBe(401);
    expect(createAdapters).not.toHaveBeenCalled();
    const unauthenticatedClient = createApiClient({ baseUrl: "https://runtime.test", getRuntimeSlot: () => "primary", onUnauthorized,
      fetchFn: async (input, init) => app.request(new URL(String(input)).pathname, { ...init, headers: { authorization: "Bearer invalid-token" } }),
    });
    await expect(unauthenticatedClient.get(`${root}/capabilities`)).rejects.toMatchObject({ category: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(createAdapters).not.toHaveBeenCalled();
    const ownerHeaders = { ...headers, "x-platform-user-id": "runtime_owner",
      "x-platform-verified": createHmac("sha256", token).update("runtime_owner").digest("hex") };
    expect((await app.request(`${root}/capabilities`, { headers: ownerHeaders })).status).toBe(200);
    expect(createAdapters).toHaveBeenCalledOnce();
  } finally { await lifecycle.close(); }
});


it("keeps an empty delivered adapter registry honest and bounded by owner authority", async () => {
  const app = new Hono();
  const lifecycle = await registerProviderWorkflowRuntime({
    app, ownerId: "owner", getPrincipal: () => ({ userId: "owner" }),
    createAdapters: async () => [],
  });
  try {
    const capabilities = await app.request("/api/ai/provider-settings/workflows/capabilities");
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual([]);
    const login = await app.request("/api/ai/provider-settings/workflows", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessInstanceId: "codex", kind: "login", method: "device_code", idempotencyKey: "empty-adapter" }),
    });
    expect(login.status).toBe(503);
  } finally { await lifecycle.close(); }
  expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(503);
});
