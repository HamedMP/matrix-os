import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { markAuthContextReady } from "../../packages/gateway/src/request-principal.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
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

describe("platform integration resource startup", () => {
  const configuredEnv = {
    PLATFORM_DATABASE_URL: "postgres://test/platform",
    PIPEDREAM_CLIENT_ID: "client",
    PIPEDREAM_CLIENT_SECRET: "secret",
    PIPEDREAM_PROJECT_ID: "project",
  };

  it("fails closed on an invalid native target before creating resources", async () => {
    const createDb = vi.fn();
    await expect(initializePlatformIntegrations({ env: { ...configuredEnv, MATRIX_NATIVE_MOBILE_TARGET: 'arbitrary://return' }, broadcast: () => undefined, createDb })).rejects.toThrow('Native mobile target unavailable');
    expect(createDb).not.toHaveBeenCalled();
  });

  it("propagates the fixed pilot return into actual local connect routes", async () => {
    const createConnectToken = vi.fn(async () => ({ connectLinkUrl: 'https://pipedream.com/connect', token: 'fixture', expiresAt: '2099-01-01' }));
    const db = { migrate: vi.fn(async () => {}), getUserByClerkId: vi.fn(async () => ({ id: 'owner', pipedream_external_id: 'external' })), getUserById: vi.fn(async () => ({ id: 'owner', pipedream_external_id: 'external' })) } as unknown as PlatformDb;
    const services = await initializePlatformIntegrations({ env: { ...configuredEnv, NODE_ENV: 'production', MATRIX_NATIVE_MOBILE_TARGET: 'gmail-pilot' }, broadcast: () => undefined,
      createDb: () => db, createClient: async () => ({ createConnectToken, getAppInfo: vi.fn(async () => null), getOAuthUrl: (url: string) => url, discoverActions: vi.fn(async () => []) } as any) });
    const app = new Hono(); app.use('*', authMiddleware('machine', { resolveMatrixMcpCapability: token => token === 'clerk-token' ? 'user_owner' : null })); app.route('/', services.routes!);
    const call = (redirectUri: string) => app.request('/connect', { method: 'POST', headers: { authorization: 'Bearer clerk-token', 'content-type': 'application/json' }, body: JSON.stringify({ service: 'github', redirectUri }) });
    expect((await call('matrixos://integrations')).status).toBe(400);
    expect((await call('matrixos-gmail-pilot://integrations')).status).toBe(200);
    expect(createConnectToken).toHaveBeenCalledOnce();
    expect(createConnectToken).toHaveBeenCalledWith('external', { successRedirectUri: 'matrixos-gmail-pilot://integrations', errorRedirectUri: 'matrixos-gmail-pilot://integrations' });
  });

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
