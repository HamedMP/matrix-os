import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { initializePlatformIntegrations } from "../../packages/gateway/src/startup/platform-integrations.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createBotIntegrationClient, createLocalIntegrationTransport } from "../../packages/gateway/src/bots/integration-client.js";

const owner = { type: "personal" as const, ownerId: "user_local_chat" };
const rowId = "123e4567-e89b-42d3-a456-426614174000";
afterEach(() => vi.unstubAllEnvs());

async function fixture(actorId = owner.ownerId) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MATRIX_USER_ID", actorId);
  const row = { id: rowId, clerk_id: owner.ownerId, pipedream_external_id: "external-local" };
  const connection = { id: "connection-local", user_id: rowId, service: "google_drive", account_label: "brain", status: "active", pipedream_account_id: "account-local", scopes: [] };
  const db = {
    migrate: vi.fn(async () => undefined),
    getUserByClerkId: vi.fn(async (id: string) => id === owner.ownerId ? row : null),
    getUserById: vi.fn(async (id: string) => id === rowId ? row : null),
    listConnectedServices: vi.fn(async (id: string) => id === rowId ? [connection] : []),
    touchServiceUsage: vi.fn(async () => undefined),
  };
  const readDriveFile = vi.fn(async () => ({ text: "owner brain contents", truncated: false }));
  const client = { getAppInfo: vi.fn(async () => ({})), discoverActions: vi.fn(async () => { throw new Error("not available on your current plan"); }), readDriveFile };
  const services = await initializePlatformIntegrations({
    env: { NODE_ENV: "production", MATRIX_USER_ID: actorId, PLATFORM_DATABASE_URL: "postgres://fixture/platform", PIPEDREAM_CLIENT_ID: "fixture-client", PIPEDREAM_CLIENT_SECRET: "fixture-secret", PIPEDREAM_PROJECT_ID: "fixture-project" },
    broadcast: () => undefined,
    createDb: () => db as unknown as PlatformDb,
    createClient: async () => client as unknown as PipedreamConnectClient,
  });
  const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: actorId });
  const grant = registry.issue({ owner: { ...owner, ownerId: actorId }, runId: "run_local", scope: "call", integrationRead: true })!;
  const app = new Hono();
  app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext }));
  app.route("/api/integrations", services.routes!);
  return { app, db, readDriveFile, registry, grant, localClient: createBotIntegrationClient(createLocalIntegrationTransport(services.routes!)), headers: { authorization: `Bearer ${grant.token}` } };
}

describe("production local Chat integration wiring", () => {
  it("also supplies verified server-side identity to the in-process app and bot transport", async () => {
    const f = await fixture();
    try {
      await expect(f.localClient.inventory(owner.ownerId)).resolves.toEqual([{ connectionId: "connection-local", service: "google_drive", label: "brain" }]);
      expect((await f.localClient.describe(owner.ownerId, { service: "google_drive", readOnly: true })).every(action => action.risk === "read")).toBe(true);
      await expect(f.localClient.callAppAction(owner.ownerId, { service: "google_drive", action: "read_file", label: "brain", connectionId: "connection-local", params: { fileId: "brain_file" }, read: true })).resolves.toMatchObject({ data: { text: "owner brain contents" } });
      expect(f.db.listConnectedServices).toHaveBeenCalledWith(rowId);
      await expect(f.localClient.inventory("user_other")).rejects.toMatchObject({ code: "denied" });
    } finally { f.registry.close(); }
  });
  it("maps an authenticated platform UUID only through its existing owner row", async () => {
    const f = await fixture(rowId);
    try {
      expect((await f.app.request("/api/integrations", { headers: f.headers })).status).toBe(200);
      expect(f.db.getUserByClerkId).toHaveBeenCalledWith(rowId);
      expect(f.db.getUserById).toHaveBeenCalledWith(rowId);
      expect(f.db.listConnectedServices).toHaveBeenCalledWith(rowId);
    } finally { f.registry.close(); }
  });

  it("keeps database outages separate from missing or unknown authenticated owners", async () => {
    const f = await fixture();
    try {
      f.db.getUserByClerkId.mockRejectedValueOnce(new Error("private database detail"));
      const unavailable = await f.app.request("/api/integrations/agent-catalog", { headers: f.headers });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: "Integration capabilities unavailable" });
      expect(f.db.getUserById).not.toHaveBeenCalled();
      f.db.getUserByClerkId.mockResolvedValueOnce(null);
      expect((await f.app.request("/api/integrations", { headers: f.headers })).status).toBe(401);
      expect(f.db.listConnectedServices).not.toHaveBeenCalled();
    } finally { f.registry.close(); }
  });

  it("uses the verified scoped owner for inventory, discovery and exact Drive reads", async () => {
    const f = await fixture();
    try {
      const inventory = await f.app.request("/api/integrations", { headers: f.headers });
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toEqual([expect.objectContaining({ id: "connection-local", account_label: "brain" })]);
      const catalog = await f.app.request("/api/integrations/agent-catalog", { headers: f.headers });
      expect(catalog.status).toBe(200);
      expect(JSON.stringify(await catalog.json())).toContain("read_file");
      const read = await f.app.request("/api/integrations/read-call", { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: JSON.stringify({ service: "google_drive", action: "read_file", label: "brain", connectionId: "connection-local", params: { fileId: "brain_file" } }) });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ data: { text: "owner brain contents" } });
      expect(f.readDriveFile).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "external-local", accountId: "account-local" }));
      expect(f.db.getUserByClerkId).toHaveBeenCalledWith(owner.ownerId);
      expect(f.db.listConnectedServices).toHaveBeenCalledWith(rowId);
    } finally { f.registry.close(); }
  });

  it("rejects forged identities, wrong account selection, writes and revoked grants", async () => {
    const f = await fixture();
    try {
      expect((await f.app.request("/api/integrations", { headers: { ...f.headers, "x-platform-user-id": "user_other" } })).status).toBe(401);
      expect((await f.app.request("/api/integrations", { headers: { authorization: "Bearer machine-secret", "x-platform-user-id": "user_other" } })).status).toBe(200);
      expect(f.db.getUserByClerkId).not.toHaveBeenCalledWith("user_other");
      const read = await f.app.request("/api/integrations/read-call", { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: JSON.stringify({ service: "google_drive", action: "read_file", label: "brain", connectionId: "connection-other", params: { fileId: "brain_file" } }) });
      expect(read.status).toBe(403);
      expect(f.readDriveFile).not.toHaveBeenCalled();
      expect((await f.app.request("/api/integrations/call", { method: "POST", headers: f.headers })).status).toBe(401);
      f.grant.revoke();
      expect((await f.app.request("/api/integrations", { headers: f.headers })).status).toBe(401);
    } finally { f.registry.close(); }
  });
});
