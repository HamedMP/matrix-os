import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const serverId = "123e4567-e89b-42d3-a456-426614174000";
const owner = { type: "personal", ownerId: "owner_claude" };

describe("Claude Custom MCP Run capability", () => {
  it("issues only for the configured personal owner outside Preview", () => {
    for (const options of [
      { configuredOwnerId: undefined },
      { configuredOwnerId: "another_owner" },
      { configuredOwnerId: "owner_claude", previewRuntime: true },
    ]) {
      const registry = createMatrixMcpCapabilityRegistry(options);
      expect(registry.issue({ owner, runId: "run_a" })).toBeNull();
    }
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    expect(registry.issue({ owner: { type: "organization", ownerId: owner.ownerId }, runId: "run_a" })).toBeNull();
    expect(registry.issue({ owner: { type: "personal", ownerId: "another_owner" }, runId: "run_a" })).toBeNull();
    expect(registry.issue({ owner, runId: "run_a" })?.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds the actor to only collection/detail reads and an exact UUID call", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capability = registry.issue({ owner, runId: "run_a" })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpCapability: registry.resolve }));
    app.all("*", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    const headers = { authorization: `Bearer ${capability.token}` };

    for (const [method, path] of [
      ["GET", "/api/mcp-servers"],
      ["GET", `/api/mcp-servers/${serverId}`],
      ["POST", `/api/mcp-servers/${serverId}/call`],
    ]) {
      const response = await app.request(path, { method, headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actor: owner.ownerId });
    }
    for (const [method, path] of [
      ["POST", "/api/mcp-servers"],
      ["DELETE", `/api/mcp-servers/${serverId}`],
      ["POST", `/api/mcp-servers/${serverId}/test`],
      ["POST", `/api/mcp-servers/${serverId}/call/extra`],
      ["GET", `/api/mcp-servers/${serverId}/call`],
      ["GET", "/api/mcp-servers/not-a-uuid"],
      ["GET", "/api/integrations"],
      ["GET", "/api/jev/test"],
      ["GET", "/api/files"],
    ]) {
      expect((await app.request(path, { method, headers })).status).toBe(401);
    }
    expect((await app.request("/api/mcp-servers", { headers: {
      ...headers, "x-platform-user-id": "another_owner", "x-platform-verified": "forged",
    } })).status).toBe(401);
    capability.revoke();
    expect((await app.request("/api/mcp-servers", { headers })).status).toBe(401);
  });

  it("binds review grants to discovery even when the caller asks for an allowed tool", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capability = registry.issue({ owner, runId: "run_review", scope: "discovery" })!;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpCapability: registry.resolve }));
    app.all("*", (c) => c.json({ actor: requireRequestPrincipal(c).userId }));
    const headers = { authorization: `Bearer ${capability.token}` };
    expect((await app.request(`/api/mcp-servers/${serverId}`, { headers })).status).toBe(200);
    expect((await app.request(`/api/mcp-servers/${serverId}/call`, {
      method: "POST", headers, body: JSON.stringify({ tool: "mutable", approvalGranted: false }),
    })).status).toBe(401);
    registry.close();
  });

  it("expires and drains Run grants", () => {
    let clock = 0;
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId, now: () => clock });
    const capability = registry.issue({ owner, runId: "run_a" })!;
    expect(registry.resolve(capability.token, "GET", "/api/mcp-servers")).toBe(owner.ownerId);
    clock = 35 * 60_000;
    expect(registry.resolve(capability.token, "GET", "/api/mcp-servers")).toBeNull();
    const next = registry.issue({ owner, runId: "run_b" })!;
    registry.close();
    expect(registry.resolve(next.token, "GET", "/api/mcp-servers")).toBeNull();
    expect(registry.issue({ owner, runId: "run_c" })).toBeNull();
  });

  it("caps active grants and frees a slot on revocation", () => {
    const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId });
    const capabilities = Array.from({ length: 128 }, (_, index) => registry.issue({ owner, runId: `run_${index}` }));
    expect(capabilities.every(Boolean)).toBe(true);
    expect(registry.issue({ owner, runId: "over_limit" })).toBeNull();
    capabilities[0]!.revoke();
    const replacement = registry.issue({ owner, runId: "replacement" });
    expect(replacement?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.resolve(capabilities[0]!.token, "GET", "/api/mcp-servers")).toBeNull();
    registry.close();
  });
});
