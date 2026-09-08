import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createIntegrationBridgeRoutes } from "../../packages/gateway/src/integrations/bridge-routes.js";

describe("integration bridge route extraction", () => {
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
