import { createApp } from "../../packages/platform/src/main.js";
import { stubOrchestrator } from "./proxy-routing-test-utils.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerCustomMcpRoutes } from "../../packages/platform/src/custom-mcp-route-registration.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";

describe("public OAuth client metadata", () => {
  it("is reachable through production app-domain routing without auth or runtime proxy", async () => {
    const app = createApp({ db: {} as PlatformDB, orchestrator: stubOrchestrator(), platformSecret: "fixture",
      clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error("No user login for metadata"); } }) });
    const result = await app.request("https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata", { headers: { host: "app.matrix-os.com" } });
    expect(result.status).toBe(200);
    expect((await result.json()).client_id).toBe("https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata");
    expect(result.headers.get("cache-control")).toContain("max-age=300");
  });
  it("publishes fixed callback metadata without a user session or Host-derived URLs", async () => {
    const app = new Hono();
    registerCustomMcpRoutes(app, { db: {} as PlatformDB, platformSecret: "secret" });
    const response = await app.request("https://attacker.invalid/api/mcp-servers/oauth/client-metadata");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client_id: "https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata",
      client_name: "Matrix OS", client_uri: "https://matrix-os.com",
      redirect_uris: ["https://app.matrix-os.com/api/mcp-servers/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect((await app.request("/api/mcp-servers")).status).toBe(401);
    expect((await app.request("/api/mcp-servers/oauth/client-metadata", { method: "POST" })).status).toBe(401);
  });
});
