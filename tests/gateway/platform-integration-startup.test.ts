import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationUserResolver } from "../../packages/gateway/src/startup/platform-integrations.js";

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
