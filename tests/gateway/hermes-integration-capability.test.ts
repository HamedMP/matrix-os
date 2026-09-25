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

  it("rejects generic integration and Jev routes for a Jev Inbox Triage run bearer", async () => {
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret"));
    for (const path of ["/api/integrations/call", "/api/integrations/read-call", "/api/integrations/sync",
      "/api/integrations/connect", "/api/integrations/disconnect", "/api/jev/evaluate"]) {
      app.post(path, (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    }
    const issueScoped = issueHermesIntegrationCapability as unknown as (actorId: string, scope: {
      kind: "jev_inbox_preview"; runId: string; agentId: string; revision: number;
      account: { service: "gmail"; accountLabel: string; connectionId: string; expectedEmail: string };
    }) => ReturnType<typeof issueHermesIntegrationCapability>;
    const capability = issueScoped("user_a", {
      kind: "jev_inbox_preview", runId: "run_jev_one", agentId: "bot_jevone01", revision: 1,
      account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_own", expectedEmail: "me@example.test" },
    });
    try {
      const headers = { authorization: `Bearer ${capability.token}` };
      for (const path of ["/api/integrations/call", "/api/integrations/read-call", "/api/integrations/sync",
        "/api/integrations/connect", "/api/integrations/disconnect", "/api/jev/evaluate"]) {
        expect((await app.request(path, { method: "POST", headers })).status, path).toBe(401);
      }
    } finally { capability.revoke(); }
  });
});
