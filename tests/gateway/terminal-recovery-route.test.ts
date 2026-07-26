import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../../packages/gateway/src/security/rate-limiter.js";
import {
  createShellRoutes,
} from "../../packages/gateway/src/shell/routes.js";

function createRegistry() {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async ({ name }: { name: string }) => ({ name })),
    delete: vi.fn(async () => undefined),
    recover: vi.fn(async (name: string) => ({
      name,
      runtimeId: "0123456789abcdef0123456789abcdef",
      lifecycleState: "recovering",
      recoverable: false,
    })),
  };
}

function createApp(
  registry: ReturnType<typeof createRegistry>,
  sessionCreateRateLimiter = createRateLimiter({
    maxAttempts: 120,
    windowMs: 60_000,
    lockoutMs: 10_000,
    maxKeys: 1,
  }),
) {
  const deps = { registry, sessionCreateRateLimiter };
  const app = new Hono();
  app.route("/api/terminal", createShellRoutes(deps));
  app.route("/api", createShellRoutes(deps));
  return app;
}

describe("terminal recovery route", () => {
  it("accepts no body or exactly an empty object and reports readiness honestly", async () => {
    const registry = createRegistry();
    const app = createApp(registry);

    const recovering = await app.request(
      "/api/terminal/sessions/calm-otter/recover",
      { method: "POST" },
    );
    expect(recovering.status).toBe(202);
    await expect(recovering.json()).resolves.toMatchObject({
      session: {
        name: "calm-otter",
        lifecycleState: "recovering",
      },
    });

    registry.recover.mockResolvedValueOnce({
      name: "calm-otter",
      runtimeId: "0123456789abcdef0123456789abcdef",
      lifecycleState: "live",
      recoverable: false,
    });
    const live = await app.request(
      "/api/sessions/calm-otter/recover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(live.status).toBe(200);
    expect(registry.recover).toHaveBeenCalledTimes(2);
  });

  it("rejects non-empty bodies, invalid names, and oversized requests generically", async () => {
    const registry = createRegistry();
    const app = createApp(registry);
    const invalidBody = await app.request(
      "/api/terminal/sessions/calm-otter/recover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
    const invalidName = await app.request(
      "/api/terminal/sessions/Bad%20Name/recover",
      { method: "POST" },
    );
    const oversized = await app.request(
      "/api/terminal/sessions/calm-otter/recover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: " ".repeat(2_000),
      },
    );

    expect(invalidBody.status).toBe(400);
    expect(invalidName.status).toBe(400);
    expect(oversized.status).toBe(413);
    await expect(invalidBody.json()).resolves.toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(registry.recover).not.toHaveBeenCalled();
  });

  it("shares the create/recover limiter across canonical and legacy mounts", async () => {
    const registry = createRegistry();
    const limiter = createRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 10_000,
      maxKeys: 1,
    });
    const app = createApp(registry, limiter);

    expect((await app.request("/api/terminal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "first-shell" }),
    })).status).toBe(201);
    const response = await app.request(
      "/api/sessions/calm-otter/recover",
      { method: "POST" },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Request failed" },
    });
    expect(registry.recover).not.toHaveBeenCalled();
  });
});
