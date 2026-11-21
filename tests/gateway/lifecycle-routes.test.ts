import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RuntimeLifecycleStatusSchema } from "@matrix-os/contracts/runtime-lifecycle";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerLifecycleRoutes } from "../../packages/gateway/src/server/lifecycle-routes.js";

const TOKEN = "lifecycle-test-token-0123456789abcdef";

function app(readStatus: Parameters<typeof registerLifecycleRoutes>[0]["readStatus"]) {
  const hono = new Hono();
  hono.use("*", authMiddleware(TOKEN));
  registerLifecycleRoutes({ app: hono, readStatus });
  return hono;
}

describe("GET /api/system/lifecycle", () => {
  it("401 without auth", async () => {
    const readStatus = vi.fn(async () => ({ busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: true }));
    const res = await app(readStatus).request("/api/system/lifecycle");
    expect(res.status).toBe(401);
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("returns the lifecycle status for the owner bearer", async () => {
    const at = "2026-11-21T13:00:00.000Z";
    const res = await app(async () => ({ busy: true, busyReasons: ["chat_run"], nextScheduledAt: at, scheduleComplete: true }))
      .request("/api/system/lifecycle", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(RuntimeLifecycleStatusSchema.safeParse({ busy: false, busyReasons: [], nextScheduledAt: null }).success).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(RuntimeLifecycleStatusSchema.parse(await res.json())).toEqual({ busy: true, busyReasons: ["chat_run"], nextScheduledAt: at, scheduleComplete: true });
  });

  it("returns a generic 503 when the status cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app(async () => { throw new Error("pg password authentication failed for /home/matrix"); })
        .request("/api/system/lifecycle", { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "lifecycle_unavailable" });
    } finally {
      error.mockRestore();
    }
  });

  it("is GET-only", async () => {
    const res = await app(async () => ({ busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: true }))
      .request("/api/system/lifecycle", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});
