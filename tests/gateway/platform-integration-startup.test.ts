import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationUserResolver, initializePlatformIntegrations } from "../../packages/gateway/src/startup/platform-integrations.js";

describe("platform integration startup identity", () => {
  it("uses the platform verified Clerk identity and rejects an unknown user", async () => {
    const getUserByClerkId = vi.fn(async (id: string) => id === "known" ? { id: "owner-id" } : null);
    const db = { getUserByClerkId } as unknown as PlatformDb;
    const app = new Hono();
    const resolve = createIntegrationUserResolver(db, { NODE_ENV: "production" });
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));

    const known = await app.request("/identity", { headers: { "x-platform-user-id": "known" } });
    expect(await known.json()).toEqual({ id: "owner-id" });
    const unknown = await app.request("/identity", { headers: { "x-platform-user-id": "unknown" } });
    expect(await unknown.json()).toEqual({ id: null });
    const missing = await app.request("/identity");
    expect(await missing.json()).toEqual({ id: null });
    expect(getUserByClerkId).toHaveBeenCalledTimes(2);
  });

  it("uses one atomic dev upsert to resolve the owner", async () => {
    const raw = vi.fn(async () => ({ rows: [{ id: "dev-owner" }] }));
    const db = { raw } as unknown as PlatformDb;
    const app = new Hono();
    const resolve = createIntegrationUserResolver(db, {
      NODE_ENV: "development", MATRIX_HANDLE: "dev", MATRIX_CLERK_USER_ID: "clerk-dev", HOSTNAME: "local",
    });
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));

    const response = await app.request("/identity");
    expect(await response.json()).toEqual({ id: "dev-owner" });
    expect(raw).toHaveBeenCalledOnce();
    expect(raw.mock.calls[0]?.[0]).toMatch(/ON CONFLICT \(clerk_id\) DO UPDATE/);
  });
});

describe("platform integration resource startup", () => {
  const configuredEnv = {
    PLATFORM_DATABASE_URL: "postgres://test/platform",
    PIPEDREAM_CLIENT_ID: "client",
    PIPEDREAM_CLIENT_SECRET: "secret",
    PIPEDREAM_PROJECT_ID: "project",
  };

  it("does not open a database when integration configuration is incomplete", async () => {
    const createDb = vi.fn();
    const result = await initializePlatformIntegrations({
      env: { PLATFORM_DATABASE_URL: configuredEnv.PLATFORM_DATABASE_URL },
      broadcast: () => undefined,
      createDb,
    });
    expect(result).toEqual({ db: null, client: null, routes: null, resolveUserId: null });
    expect(createDb).not.toHaveBeenCalled();
  });

  it("closes a migrated platform database if client startup fails", async () => {
    const migrate = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const db = { migrate, destroy } as unknown as PlatformDb;
    const result = await initializePlatformIntegrations({
      env: configuredEnv,
      broadcast: () => undefined,
      createDb: () => db,
      createClient: async () => { throw new Error("client unavailable"); },
    });
    expect(result.db).toBeNull();
    expect(migrate).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
