import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { markAuthContextReady } from "../../packages/gateway/src/request-principal.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { integrationClerkIdForPrincipal } from "../../packages/gateway/src/integrations/principal-identity.js";
import { createIntegrationUserResolver, initializePlatformIntegrations } from "../../packages/gateway/src/startup/platform-integrations.js";

describe("platform integration startup identity", () => {
  it("uses the platform verified Clerk identity and rejects an unknown user", async () => {
    const getUserByClerkId = vi.fn(async (id: string) => id === "known" ? { id: "owner-id" } : null);
    const db = { getUserByClerkId } as unknown as PlatformDb;
    const app = new Hono();
    app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpCapability: token => token === "known-token" ? "known" : token === "unknown-token" ? "unknown" : null }));
    const resolve = createIntegrationUserResolver(db, { NODE_ENV: "production" });
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));

    const known = await app.request("/identity", { headers: { authorization: "Bearer known-token" } });
    expect(await known.json()).toEqual({ id: "owner-id" });
    const unknown = await app.request("/identity", { headers: { authorization: "Bearer unknown-token" } });
    expect(await unknown.json()).toEqual({ id: null });
    const missing = await app.request("/identity");
    expect(missing.status).toBe(401);
    expect((await app.request("/identity", { headers: { "x-platform-user-id": "known" } })).status).toBe(401);
    expect(getUserByClerkId).toHaveBeenCalledTimes(2);
  });

  it("uses one atomic dev upsert to resolve the owner", async () => {
    const raw = vi.fn(async () => ({ rows: [{ id: "dev-owner" }] }));
    const db = { raw } as unknown as PlatformDb;
    const app = new Hono();
    const resolve = createIntegrationUserResolver(db, {
      NODE_ENV: "development", MATRIX_HANDLE: "dev", MATRIX_CLERK_USER_ID: "clerk-dev", HOSTNAME: "local",
    });
    app.use("*", async (c, next) => { markAuthContextReady(c); await next(); });
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));

    const response = await app.request("/identity");
    expect(await response.json()).toEqual({ id: "dev-owner" });
    expect(raw).toHaveBeenCalledOnce();
    expect(raw.mock.calls[0]?.[0]).toMatch(/ON CONFLICT \(clerk_id\) DO UPDATE/);
  });

  it("fails on missing auth wiring without entering the development upsert", async () => {
    const raw = vi.fn();
    const resolve = createIntegrationUserResolver({ raw } as unknown as PlatformDb, { NODE_ENV: "development" });
    const app = new Hono();
    app.onError(() => new Response("Unavailable", { status: 503 }));
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));
    expect((await app.request("/identity", { headers: { "x-platform-user-id": "forged" } })).status).toBe(503);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe("integration identity of the dev principal", () => {
  it("stores the dev connection under the Clerk id the brain reads for the dev principal", async () => {
    const env = { NODE_ENV: "development", MATRIX_HANDLE: "dev", HOSTNAME: "local" };
    const raw = vi.fn(async () => ({ rows: [{ id: "dev-owner" }] }));
    const app = new Hono();
    const resolve = createIntegrationUserResolver({ raw } as unknown as PlatformDb, env);
    app.get("/identity", async (c) => c.json({ id: await resolve(c) }));
    await app.request("/identity");
    const stored = (raw.mock.calls[0] as unknown as [string, string[]])[1][0];
    expect(stored).toBe("dev");
    expect(integrationClerkIdForPrincipal("default", env)).toBe(stored);
    expect(integrationClerkIdForPrincipal("default", { ...env, MATRIX_CLERK_USER_ID: "clerk-dev" })).toBe("clerk-dev");
    expect(integrationClerkIdForPrincipal("default", {})).toBe("default");
    expect(integrationClerkIdForPrincipal("default", { ...env, NODE_ENV: "production" })).toBe("default");
    expect(integrationClerkIdForPrincipal("user_2abc", env)).toBe("user_2abc");
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
