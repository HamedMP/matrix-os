import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const owner = { type: "personal", ownerId: "owner_codex" };

describe("owner/run-scoped integration read capability", () => {
  it("admits only inventory, catalog and the dedicated read call for its exact owner", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    // The red test intentionally asks the B1 registry for the new disjoint scope.
    const capability = registry.issue({ owner, runId: "run_codex_read_1", scope: "integration_read" as never });
    expect(capability?.token).toMatch(/^[a-f0-9]{64}$/);

    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpCapability: registry.resolve }));
    app.all("*", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    const headers = { authorization: `Bearer ${capability!.token}` };

    for (const [method, path] of [
      ["GET", "/api/integrations"],
      ["GET", "/api/integrations/agent-catalog"],
      ["POST", "/api/integrations/read-call"],
    ]) {
      const response = await app.request(path, { method, headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actor: owner.ownerId });
    }
    for (const [method, path] of [
      ["POST", "/api/integrations/call"],
      ["POST", "/api/integrations/connect"],
      ["POST", "/api/integrations/sync"],
      ["DELETE", "/api/integrations"],
      ["GET", "/api/integrations/read-call"],
      ["POST", "/api/integrations/read-call/extra"],
      ["GET", "/api/mcp-servers"],
      ["POST", "/api/mcp-servers/123e4567-e89b-42d3-a456-426614174000/call"],
    ]) {
      expect((await app.request(path, { method, headers })).status).toBe(401);
    }
    expect((await app.request("/api/integrations", { headers: {
      ...headers, "x-platform-user-id": "another_owner", "x-platform-verified": "forged",
    } })).status).toBe(401);
    capability!.revoke();
    expect((await app.request("/api/integrations", { headers })).status).toBe(401);
    registry.close();
  });

  it("rejects a wrong owner, unknown scope, malformed token and expired grant", () => {
    let clock = 0;
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId, now: () => clock });
    expect(registry.issue({ owner: { ...owner, ownerId: "other_owner" }, runId: "run_a", scope: "integration_read" as never })).toBeNull();
    expect(registry.issue({ owner, runId: "run_a", scope: "arbitrary" as never })).toBeNull();
    const capability = registry.issue({ owner, runId: "run_a", scope: "integration_read" as never });
    expect(capability).not.toBeNull();
    expect(registry.resolve("", "GET", "/api/integrations")).toBeNull();
    expect(registry.resolve("bad", "GET", "/api/integrations")).toBeNull();
    expect(registry.resolve(capability!.token, "GET", "/api/integrations")).toBe(owner.ownerId);
    clock = 35 * 60_000;
    expect(registry.resolve(capability!.token, "GET", "/api/integrations")).toBeNull();
    registry.close();
  });
});
