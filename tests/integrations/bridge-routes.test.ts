import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationBridgeRoutes } from "../../packages/gateway/src/integrations/bridge-routes.js";

describe("integration bridge route extraction", () => {
  const callGmail = (label: string) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "gmail", action: "get_profile", label }),
  });

  it("rejects an ambiguous exact account label before any provider call", async () => {
    const pipedream = { proxyGet: vi.fn(), proxyPost: vi.fn(), runAction: vi.fn() };
    const platformDb = {
      listConnectedServices: vi.fn(async () => [
        { service: "gmail", account_label: "Shared", pipedream_account_id: "owned_one" },
        { service: "gmail", account_label: "Shared", pipedream_account_id: "owned_two" },
      ]),
      getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner" })),
      touchServiceUsage: vi.fn(),
    };
    const app = createIntegrationBridgeRoutes({
      platformDb: platformDb as never, pipedream: pipedream as never,
      resolveUserId: async () => "owner",
    });

    const response = await app.request("/", callGmail("Shared"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Integration account label is ambiguous" });
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
    expect(pipedream.runAction).not.toHaveBeenCalled();
  });

  it("uses the only exact owner label while missing and foreign labels never reach the provider", async () => {
    const pipedream = { proxyGet: vi.fn(async () => ({ emailAddress: "personal@example.test" })),
      proxyPost: vi.fn(), runAction: vi.fn() };
    const platformDb = {
      listConnectedServices: vi.fn(async (ownerId: string) => ownerId === "owner" ? [
        { id: "personal", service: "gmail", account_label: "Personal", pipedream_account_id: "owned_personal" },
      ] : [
        { id: "foreign", service: "gmail", account_label: "Foreign", pipedream_account_id: "other_owner" },
      ]),
      getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner" })),
      touchServiceUsage: vi.fn(),
    };
    const app = createIntegrationBridgeRoutes({
      platformDb: platformDb as never, pipedream: pipedream as never,
      resolveUserId: async () => "owner",
    });

    const selected = await app.request("/", callGmail("Personal"));
    expect(selected.status).toBe(200);
    expect(pipedream.proxyGet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      externalUserId: "pd_owner", accountId: "owned_personal",
    }));
    pipedream.proxyGet.mockClear();

    for (const label of ["Missing", "Foreign"]) {
      const response = await app.request("/", callGmail(label));
      expect(response.status).toBe(404);
      expect(pipedream.proxyGet).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid Gmail cursors through the shared validator before owner lookup", async () => {
    const resolveUserId = vi.fn(async () => "user-1");
    const app = createIntegrationBridgeRoutes({
      platformDb: {} as never,
      pipedream: {} as never,
      resolveUserId,
    });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "gmail", action: "list_messages", params: { pageToken: "bad\nheader" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid param type: params: invalid value" });
    expect(resolveUserId).not.toHaveBeenCalled();
  });

  it("keeps missing integration dependencies behind a generic service error", async () => {
    const app = new Hono();
    app.route("/api/bridge/service", createIntegrationBridgeRoutes({
      platformDb: null,
      pipedream: null,
      resolveUserId: null,
    }));

    const response = await app.request("/api/bridge/service");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Integrations not configured" });
  });

  it("does not expose validation internals for malformed calls", async () => {
    const app = createIntegrationBridgeRoutes({
      platformDb: {} as never,
      pipedream: {} as never,
      resolveUserId: async () => "user-1",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "twitter" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });
});
