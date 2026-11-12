import { describe, expect, it, vi } from "vitest";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import type { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { RegisteredMcpOAuthClients } from "../../packages/gateway/src/integrations/custom-mcp/catalog-presets.js";

function broker() {
  return {
    list: vi.fn(async () => []),
    describe: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn(),
    discover: vi.fn(), test: vi.fn(), callSelectedTool: vi.fn(),
  } as unknown as CustomMcpBroker;
}

describe("Custom MCP HTTP boundary", () => {
  it("shows an administrator setup requirement for a rejected OAuth client without exposing upstream details", async () => {
    const { CustomMcpBrokerError } = await import("../../packages/gateway/src/integrations/custom-mcp/broker.js");
    const app = createCustomMcpRoutes({ broker: broker(), resolveUserId: async () => "owner", oauth: {
      start: vi.fn(async () => { throw new CustomMcpBrokerError("oauth_client_setup_required", "private endpoint and credential detail"); }), complete: vi.fn(),
    } });
    const response = await app.request("/5f03d43b-bbc4-47f0-97d2-a281cf15c4c3/connect", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Administrator setup is required before sign-in", code: "oauth_client_setup_required" });
  });
  it("completes an OAuth callback from state without a Matrix session", async () => {
    const complete = vi.fn(async () => ({
      serverId: "5f03d43b-bbc4-47f0-97d2-a281cf15c4c3",
    }));
    const app = createCustomMcpRoutes({
      broker: broker(),
      resolveUserId: async () => null,
      oauth: {
        start: vi.fn(),
        complete,
      },
    });

    const response = await app.request(
      `/oauth/callback?state=${"s".repeat(32)}&code=provider-code`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      serverId: "5f03d43b-bbc4-47f0-97d2-a281cf15c4c3",
    });
    expect(complete).toHaveBeenCalledWith("s".repeat(32), "provider-code");
  });

  it("checks owner identity before revealing whether an id exists", async () => {
    const service = broker();
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => null });
    const response = await app.request("/5f03d43b-bbc4-47f0-97d2-a281cf15c4c3");
    expect(response.status).toBe(401);
    expect(service.describe).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and credentials for no-auth servers", async () => {
    const app = createCustomMcpRoutes({ broker: broker(), resolveUserId: async () => "owner" });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", url: "https://mcp.acme.tools/mcp", authMode: "none", credential: "secret" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns a generic client error for a broker-rejected URL", async () => {
    const service = broker();
    // Use the actual error class shape so no URL details escape the boundary.
    const { CustomMcpBrokerError } = await import("../../packages/gateway/src/integrations/custom-mcp/broker.js");
    vi.mocked(service.create).mockRejectedValueOnce(new CustomMcpBrokerError("invalid"));
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner" });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", url: "http://127.0.0.1/mcp", authMode: "none" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Custom MCP request" });
  });

  it("does not expose the broker call route on public route sets", async () => {
    const service = broker();
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner" });
    const response = await app.request("/5f03d43b-bbc4-47f0-97d2-a281cf15c4c3/call", { method: "POST" });
    expect(response.status).toBe(404);
    expect(service.callSelectedTool).not.toHaveBeenCalled();
  });
});

describe("Custom MCP catalog presets at the HTTP boundary", () => {
  const catalog = RegisteredMcpOAuthClients.fromEnv({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh", MCP_OAUTH_GITHUB_CLIENT_SECRET: "gh-secret-value" });
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists connectable presets for a signed-in owner with validated filters", async () => {
    const app = createCustomMcpRoutes({ broker: broker(), resolveUserId: async () => "owner", catalog });
    const response = await app.request("/catalog?department=engineering");
    expect(response.status).toBe(200);
    const body = await response.json() as { presets: Array<{ id: string; departments: string[] }> };
    expect(body.presets.map(preset => preset.id)).toEqual(expect.arrayContaining(["github", "linear"]));
    expect(body.presets.every(preset => preset.departments.includes("engineering"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("gh-secret-value");
    expect((await app.request("/catalog?department=legal")).status).toBe(400);
    expect((await app.request("/catalog?category=Bad-Category")).status).toBe(400);
    expect((await app.request("/catalog?limit=5")).status).toBe(400);
  });

  it("requires an owner session for the catalog", async () => {
    const app = createCustomMcpRoutes({ broker: broker(), resolveUserId: async () => null, catalog });
    expect((await app.request("/catalog")).status).toBe(401);
  });

  // Fault: a preset connect is created with a URL or auth mode the catalog did not pin.
  it("pre-fills URL, auth mode, and name from a connectable catalog id", async () => {
    const service = broker();
    vi.mocked(service.create).mockResolvedValue({ id: "created" } as never);
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner", catalog });
    expect((await app.request("/", json({ catalogId: "github" }))).status).toBe(201);
    expect((await app.request("/", json({ catalogId: "context7", name: "Docs" }))).status).toBe(201);
    expect(service.create).toHaveBeenNthCalledWith(1, "owner", { name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "oauth" });
    expect(service.create).toHaveBeenNthCalledWith(2, "owner", { name: "Docs", url: "https://mcp.context7.com/mcp", authMode: "none" });
  });

  it("rejects hidden, unknown, or overridden catalog presets without calling the broker", async () => {
    const service = broker();
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner", catalog });
    for (const body of [
      { catalogId: "slack" }, { catalogId: "gmail" }, { catalogId: "nope" }, { catalogId: "__proto__" },
      { catalogId: "linear", url: "https://attacker.example/mcp" }, { catalogId: "linear", authMode: "none" },
    ]) {
      const response = await app.request("/", json(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request body" });
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it("keeps arbitrary HTTPS MCP URLs connectable", async () => {
    const service = broker();
    vi.mocked(service.create).mockResolvedValue({ id: "created" } as never);
    const app = createCustomMcpRoutes({ broker: service, resolveUserId: async () => "owner", catalog });
    expect((await app.request("/", json({ name: "Acme", url: "https://mcp.acme.tools/mcp", authMode: "oauth" }))).status).toBe(201);
  });
});
