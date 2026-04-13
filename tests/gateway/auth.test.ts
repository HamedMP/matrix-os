import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";

const TEST_TOKEN = "test-bearer-token-for-auth-tests";

function createTestApp() {
  const app = new Hono();
  app.use("*", authMiddleware(TEST_TOKEN));

  // Protected API route
  app.get("/api/apps/:slug/manifest", (c) => c.json({ ok: true }));
  app.post("/api/apps/:slug/session", (c) => c.json({ ok: true }));
  app.post("/api/apps/:slug/ack", (c) => c.json({ ok: true }));

  // App iframe route (should be exempted)
  app.get("/apps/:slug/*", (c) => c.json({ ok: true, slug: c.req.param("slug") }));

  // Regular protected route
  app.get("/api/conversations", (c) => c.json({ ok: true }));

  return app;
}

describe("authMiddleware app iframe exemption", () => {
  it("exempts /apps/* from bearer auth (calls next without principal)", async () => {
    const app = createTestApp();
    const res = await app.request("/apps/notes/index.html");
    // Should pass through without bearer auth
    expect(res.status).toBe(200);
  });

  it("exempts /apps/:slug/ root path", async () => {
    const app = createTestApp();
    const res = await app.request("/apps/calculator/");
    expect(res.status).toBe(200);
  });

  it("still requires bearer auth for /api/apps/:slug/manifest", async () => {
    const app = createTestApp();
    const res = await app.request("/api/apps/notes/manifest");
    expect(res.status).toBe(401);

    const authedRes = await app.request("/api/apps/notes/manifest", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(authedRes.status).toBe(200);
  });

  it("still requires bearer auth for /api/apps/:slug/session", async () => {
    const app = createTestApp();
    const res = await app.request("/api/apps/notes/session", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("still requires bearer auth for /api/apps/:slug/ack", async () => {
    const app = createTestApp();
    const res = await app.request("/api/apps/notes/ack", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("still requires bearer auth for non-/apps/* routes", async () => {
    const app = createTestApp();
    const res = await app.request("/api/conversations");
    expect(res.status).toBe(401);
  });

  it("does not accidentally exempt /api/apps/ (only /apps/ prefix)", async () => {
    const app = createTestApp();
    const res = await app.request("/api/apps/notes/manifest");
    expect(res.status).toBe(401);
  });
});
