import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { issueHermesIntegrationCapability, resolveHermesIntegrationCapability } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
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

  it.each([
    ["GET", "/api/integrations"], ["POST", "/api/integrations/call"],
    ["POST", "/api/integrations/read-call"], ["POST", "/api/integrations/sync"],
    ["POST", "/api/integrations/connect"], ["POST", "/api/integrations/disconnect"],
    ["POST", "/api/integrations/custom-mcp/call"], ["GET", "/api/jev/inbox/preview"],
    ["PATCH", "/api/jev/inbox/preview"], ["POST", "/api/jev/inbox/%70review"],
    ["POST", "/api/jev/inbox/preview/"], ["POST", "/api/jev/evaluate"],
  ])("denies a recipe bearer on %s %s", async (method, path) => {
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret"));
    app.on(["GET", "POST", "PATCH"], "*", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    const capability = issueHermesIntegrationCapability("user_a", {
      kind: "jev_inbox_preview", runId: "run_matrix", agentId: "bot_jevone01", revision: 1,
      account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_own", expectedEmail: "me@example.test" },
    });
    try {
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${capability.token}`,
        "x-real-ip": `fixture-${method}-${path}` } })).status).toBe(401);
    } finally { capability.revoke(); }
  });

  it("expires a recipe bearer and loses it on a restarted process", async () => {
    const scope = { kind: "jev_inbox_preview" as const, runId: "run_expire", agentId: "bot_jevone01", revision: 1,
      account: { service: "gmail" as const, accountLabel: "My Gmail", connectionId: "conn_own", expectedEmail: "me@example.test" } };
    const resolve = (token: string) => resolveHermesIntegrationCapability(token, "POST", "/api/jev/inbox/preview");
    const first = issueHermesIntegrationCapability("user_a", scope);
    try {
      expect(resolve(first.token)).toBe("user_a");
      vi.setSystemTime(Date.now() + 36 * 60_000);
      expect(resolve(first.token)).toBeNull();
    } finally { first.revoke(); vi.useRealTimers(); }
    const second = issueHermesIntegrationCapability("user_a", scope);
    try {
      vi.resetModules();
      const restarted = await import("../../packages/gateway/src/chat/hermes-integration-capability.js");
      expect(restarted.resolveHermesIntegrationCapability(second.token, "POST", "/api/jev/inbox/preview")).toBeNull();
    } finally { second.revoke(); }
  });
});
