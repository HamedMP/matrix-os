import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationBridgeRoutes } from "../../packages/gateway/src/integrations/bridge-routes.js";

describe("integration bridge route extraction", () => {
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
