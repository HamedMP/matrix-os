import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { cleanupProxyRoutingTest, setupProxyRoutingTest, stubOrchestrator } from "./proxy-routing-test-utils.js";

let db: PlatformDB;
beforeEach(async () => {
  db = await setupProxyRoutingTest();
  await insertUserMachine(db, {
    machineId: "machine-alice", clerkUserId: "user_alice", handle: "alice",
    hetznerServerId: 123, publicIPv4: "203.0.113.11", status: "running",
    imageVersion: "matrix-os-host-dev", provisionedAt: "2026-05-06T00:00:00.000Z",
  });
});
afterEach(async () => { await cleanupProxyRoutingTest(db); });

it.each([
  ["TimeoutError", 504, "Runtime request timed out"],
  ["TypeError", 502, "VPS unreachable"],
])("distinguishes runtime %s without leaking upstream details", async (name, status, message) => {
  const error = new Error("private upstream details"); error.name = name;
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp({ db, orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: "user_alice" }) }),
    platformSecret: "platform-secret-123",
  });
  const response = await app.request("/api/aoede/readiness", { headers: {
    host: "app.matrix-os.com", authorization: "Bearer clerk-session",
  } });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: message });
});
