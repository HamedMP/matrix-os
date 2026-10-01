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
    expect((await app.request("/api/ai/provider-settings/workflows/capabilities")).status).toBe(401);
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
