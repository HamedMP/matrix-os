import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../../packages/platform/src/main.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator, JWT_SECRET } from "./proxy-routing-test-utils.js";

describe("unavailable Custom MCP routes", () => {
  let db: PlatformDB;
  beforeEach(async () => { process.env.PLATFORM_JWT_SECRET = JWT_SECRET; db = await setupProxyRoutingTest(); });
  afterEach(async () => { await cleanupProxyRoutingTest(db); });

  it.each([["GET", "/api/mcp-servers"], ["POST", "/api/mcp-servers/server/discover"], ["DELETE", "/api/mcp-servers/server"]])("keeps authenticated %s %s out of admin auth", async (method, path) => {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "admin-secret" });
    const token = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_alice", handle: "alice", gatewayUrl: "https://app.matrix-os.com" });
    const response = await app.request(path, { method, headers: { host: "app.matrix-os.com", authorization: `Bearer ${token.token}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "MCP servers unavailable" });
  });

  it("keeps unavailable internal MCP routes out of admin auth", async () => {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "admin-secret" });
    const response = await app.request("/internal/containers/alice/mcp-servers", { headers: { host: "api.matrix-os.com" } });
    expect(response.status).toBe(503);
  });
  it("still rejects unauthenticated public requests", async () => {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "admin-secret" });
    const response = await app.request("/api/mcp-servers", { headers: { host: "app.matrix-os.com" } });
    expect(response.status).toBe(401);
  });

  it("serves enabled MCP routes with the authenticated owner", async () => {
    const customMcpRoutes = new Hono();
    customMcpRoutes.get("/", (c) => c.json({ userId: c.get("platformUserId") }));
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "admin-secret", customMcpRoutes });
    const token = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_alice", handle: "alice", gatewayUrl: "https://app.matrix-os.com" });
    const response = await app.request("/api/mcp-servers", { headers: { host: "app.matrix-os.com", authorization: `Bearer ${token.token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user_alice" });
  });

});
