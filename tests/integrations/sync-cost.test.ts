import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

describe("credit-free sync for existing accounts", () => {
  let db: PlatformDb;
  let owner: string;
  let app: Hono;
  const listAccounts = vi.fn();
  const proxyGet = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    const pg = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pg.dialect });
    await db.migrate();
    const user = await db.createUser({ clerkId: "sync-owner", handle: "syncowner", displayName: "Owner", email: "owner@example.test", containerId: "sync-container" });
    owner = user.id;
    app = new Hono();
    app.route("/api/integrations", createIntegrationRoutes({ db, webhookSecret: "sync-test-secret", resolveUserId: async () => owner,
      pipedream: { listAccounts, proxyGet, discoverActions: vi.fn().mockResolvedValue([]), getAppInfo: vi.fn().mockResolvedValue(null) } as unknown as PipedreamConnectClient }));
  });
  afterEach(async () => { await db.destroy(); });
  const sync = () => app.request("/api/integrations/sync", { method: "POST" });
  async function existing(service = "github") {
    await db.connectService({ userId: owner, service, pipedreamAccountId: "apn_existing", accountLabel: service, scopes: [] });
  }
  it("does not repeatedly query private GitHub profiles that cannot supply an email", async () => {
    await existing();
    listAccounts.mockResolvedValue([{ id: "apn_existing", app: "github" }]);
    proxyGet.mockResolvedValue({ email: null });
    expect((await sync()).status).toBe(200);
    expect((await sync()).status).toBe(200);
    expect(proxyGet).not.toHaveBeenCalled();
    expect((await db.listConnectedServices(owner))[0].account_email).toBeNull();
  });
  it("backfills an existing email from free account-list metadata", async () => {
    await existing("google_drive");
    listAccounts.mockResolvedValue([{ id: "apn_existing", app: "google_drive", email: "drive@example.test" }]);
    expect((await sync()).status).toBe(200);
    expect(proxyGet).not.toHaveBeenCalled();
    expect((await db.listConnectedServices(owner))[0].account_email).toBe("drive@example.test");
  });
  it("does not mistake an account display name for an email", async () => {
    await existing();
    listAccounts.mockResolvedValue([{ id: "apn_existing", app: "github", email: "octocat" }]);
    expect((await sync()).status).toBe(200);
    expect((await db.listConnectedServices(owner))[0].account_email).toBeNull();
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it("looks up a new account once and keeps later consent polling credit-free", async () => {
    listAccounts.mockResolvedValue([{ id: "apn_existing", app: "google_drive" }]);
    proxyGet.mockResolvedValue({ email: "drive@example.test" });
    expect((await sync()).status).toBe(200);
    expect((await sync()).status).toBe(200);
    expect(proxyGet).toHaveBeenCalledOnce();
  });
});
