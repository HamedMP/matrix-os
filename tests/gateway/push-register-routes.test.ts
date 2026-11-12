import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Kysely } from "kysely";
import { createPostHogErrorTracker } from "@matrix-os/observability";
import { createInteractionLogger } from "../../packages/gateway/src/logger.js";
import { createPushAdapter, type PushAdapter } from "../../packages/gateway/src/channels/push.js";
import { createPushTokenStore } from "../../packages/gateway/src/notifications/push-tokens.js";
import { bootstrapNotificationDatabase, type NotificationDatabase } from "../../packages/gateway/src/notifications/schema.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { registerSystemOperatorRoutes } from "../../packages/gateway/src/server/system-operator-routes.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

function createApp(homePath: string, pushAdapter: PushAdapter): Hono {
  const app = new Hono();
  app.use(async (c, next) => {
    markAuthContextReady(c);
    setPlatformVerifiedPrincipal(c, "owner_a");
    await next();
  });
  registerSystemOperatorRoutes({
    app, homePath, model: undefined, runningVersion: "test",
    interactionLogger: createInteractionLogger(homePath), pushAdapter,
    posthogErrorTracker: createPostHogErrorTracker({ service: "matrix-gateway", env: {} }), ownerTelemetryDistinctId: "test",
    upgradeBodyLimit: bodyLimit({ maxSize: 4096 }), logBestEffortFailure: () => undefined,
  });
  return app;
}

function pushRequest(method: "POST" | "DELETE", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("POST/DELETE /api/push/register", () => {
  let homePath: string;
  const adapters: PushAdapter[] = [];

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "push-routes-"));
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.dispose();
    vi.restoreAllMocks();
    await rm(homePath, { recursive: true, force: true });
  });

  it("stores the owner's token in Postgres and removes it, with the unchanged response contract", async () => {
    const pglite = await createTestPGlite();
    const db = new Kysely<NotificationDatabase>({ dialect: pglite.dialect });
    try {
      await bootstrapNotificationDatabase(db);
      const pushAdapter = createPushAdapter({ tokens: createPushTokenStore(db) });
      adapters.push(pushAdapter);
      const app = createApp(homePath, pushAdapter);

      const registered = await app.request("/api/push/register", pushRequest("POST", { token: " ExponentPushToken[phone] ", platform: "ios" }));
      expect(registered.status).toBe(200);
      expect(await registered.json()).toEqual({ ok: true });
      expect(await db.selectFrom("notification_push_tokens").select(["token", "owner_id", "platform"]).execute())
        .toEqual([{ token: "ExponentPushToken[phone]", owner_id: "owner_a", platform: "ios" }]);

      const removed = await app.request("/api/push/register", pushRequest("DELETE", { token: "ExponentPushToken[phone]" }));
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ ok: true });
      expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("rejects invalid and oversized bodies before touching storage", async () => {
    const pushAdapter = createPushAdapter({ tokens: null });
    adapters.push(pushAdapter);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const register = vi.spyOn(pushAdapter, "registerToken");
    const remove = vi.spyOn(pushAdapter, "removeToken");
    const app = createApp(homePath, pushAdapter);

    expect((await app.request("/api/push/register", pushRequest("POST", { platform: "ios" }))).status).toBe(400);
    expect((await app.request("/api/push/register", pushRequest("DELETE", {}))).status).toBe(400);
    const oversized = JSON.stringify({ token: "x".repeat(5_000) });
    expect((await app.request("/api/push/register", pushRequest("DELETE", oversized))).status).toBe(413);
    expect(register).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when the owner database is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pushAdapter = createPushAdapter({ tokens: null });
    adapters.push(pushAdapter);
    const app = createApp(homePath, pushAdapter);

    for (const [method, body] of [["POST", { token: "ExponentPushToken[phone]", platform: "ios" }], ["DELETE", { token: "ExponentPushToken[phone]" }]] as const) {
      const response = await app.request("/api/push/register", pushRequest(method, body));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Push registration unavailable" });
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Owner database unavailable"));
  });

  it("returns a generic 500 without the database error when storage fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = {
      register: async () => { throw new Error("connection to 10.0.0.5 refused"); },
      remove: async () => { throw new Error("connection to 10.0.0.5 refused"); },
      removeDeviceTokens: async () => undefined,
      listRecent: async () => [],
      deleteUnseenBefore: async () => 0,
    };
    const pushAdapter = createPushAdapter({ tokens: failing });
    adapters.push(pushAdapter);
    const app = createApp(homePath, pushAdapter);

    for (const [method, body] of [["POST", { token: "ExponentPushToken[phone]", platform: "ios" }], ["DELETE", { token: "ExponentPushToken[phone]" }]] as const) {
      const response = await app.request("/api/push/register", pushRequest(method, body));
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Push registration failed" });
      expect(text).not.toContain("10.0.0.5");
    }
    expect(error).toHaveBeenCalledWith("[push] Push token storage failed:", "Error");
    expect(String(error.mock.calls)).not.toContain("10.0.0.5");
  });
});
