import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { issueHermesIntegrationCapability } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";

describe("Hermes integration capability", () => {
  it("binds an unforgeable bearer to one actor and only integration/Jev routes", async () => {
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret"));
    app.get("/api/integrations", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    app.get("/api/jev/test", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    app.get("/api/files", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    const capability = issueHermesIntegrationCapability("user_a");
    const headers = { authorization: `Bearer ${capability.token}` };
    expect((await app.request("/api/integrations", { headers })).status).toBe(200);
    expect(await (await app.request("/api/jev/test", { headers })).json()).toEqual({ actor: "user_a" });
    expect((await app.request("/api/files", { headers })).status).toBe(401);
    expect((await app.request("/api/integrations", { headers: {
      ...headers, "x-platform-user-id": "user_b", "x-platform-verified": "forged",
    } })).status).toBe(401);
    capability.revoke();
    expect((await app.request("/api/integrations", { headers })).status).toBe(401);
  });
});
