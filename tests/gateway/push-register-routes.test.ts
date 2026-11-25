import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
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
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket.js";
import { buildPreviewTerminalAccess } from "../../packages/platform/src/preview-terminal-access.js";

function createApp(homePath: string, pushAdapter: PushAdapter, ownerId = "owner_a", auth?: MiddlewareHandler): Hono {
  const app = new Hono();
  app.use(auth ?? (async (c, next) => {
    markAuthContextReady(c);
    setPlatformVerifiedPrincipal(c, ownerId);
    await next();
  }));
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
    vi.stubEnv("MATRIX_USER_ID", "owner_a");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "owner_a");
    homePath = await mkdtemp(join(tmpdir(), "push-routes-"));
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) adapter.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("reads the actual registration for this owner and computer without leaking another owner's token", async () => {
    const pglite = await createTestPGlite();
    const db = new Kysely<NotificationDatabase>({ dialect: pglite.dialect });
    try {
      await bootstrapNotificationDatabase(db);
      let now = Date.now();
      const push = createPushAdapter({ tokens: createPushTokenStore(db), now: () => now });
      adapters.push(push);
      const app = createApp(homePath, push);
      const status = async () => {
        const response = await app.request("/api/push/status", pushRequest("POST", { token: "ExponentPushToken[phone]" }));
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await status()).toEqual({ enabled: false, registered: false });
      await push.registerToken("ExponentPushToken[phone]", "ios", "owner_b");
      expect(await status()).toEqual({ enabled: false, registered: false });
      await push.registerToken("ExponentPushToken[phone]", "ios", "owner_a");
      expect(await status()).toEqual({ enabled: true, registered: true });
      now += 31 * 24 * 60 * 60 * 1000;
      expect(await status()).toEqual({ enabled: true, registered: false });
    } finally {
      await db.destroy();
    }
  });

  it("allows the real authenticated owner, while refusing foreign and shared-preview actors before reading registration", async () => {
    const handle = "pr-3520";
    const secret = "push-status-platform-regression-secret";
    vi.stubEnv("MATRIX_HANDLE", handle);
    vi.stubEnv("MATRIX_RUNTIME_SLOT", handle);
    vi.stubEnv("PLATFORM_JWT_SECRET", "");
    vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
    const token = buildPlatformVerificationToken(handle, secret);
    const push = createPushAdapter({ tokens: null });
    adapters.push(push);
    const status = vi.spyOn(push, "getRegistrationStatus").mockResolvedValue({ enabled: true, registered: true });
    const app = createApp(homePath, push, "owner_a", authMiddleware(token));
    const body = pushRequest("POST", { token: "ExponentPushToken[phone]" });
    const headers = (userId: string) => ({
      "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      "x-platform-user-id": userId,
      "x-platform-verified": buildPlatformUserProof(handle, userId, secret),
    });
    const owner = await app.request("/api/push/status", { ...body, headers: headers("owner_a") });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ enabled: true, registered: true });
    expect((await app.request("/api/push/status", body)).status).toBe(401);
    expect((await app.request("/api/push/status", { ...body, headers: headers("foreign_user") })).status).toBe(403);
    const access = buildPreviewTerminalAccess({
      machine: { handle, runtimeSlot: handle, provisioningClass: "preview", clerkUserId: "owner_a", accessClerkUserIds: ["shared_actor"] },
      actorId: "shared_actor", path: "/api/terminal/workspaces", platformSecret: secret,
    });
    expect(access).toBeDefined();
    expect((await app.request("/api/push/status", { ...body, headers: {
      ...headers("shared_actor"), "x-platform-preview-terminal": access!,
    } })).status).toBe(403);
    expect(status).toHaveBeenCalledExactlyOnceWith("ExponentPushToken[phone]", "owner_a");
    const refresh = vi.spyOn(push, "refreshToken").mockResolvedValue(true);
    const renewal = pushRequest("POST", { token: "delivery", identity: "private-phone-identity", platform: "ios", mode: "refresh" });
    const renewed = await app.request("/api/push/register", { ...renewal, headers: headers("owner_a") });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ ok: true, registered: true });
    expect((await app.request("/api/push/register", renewal)).status).toBe(401);
    expect((await app.request("/api/push/register", { ...renewal, headers: headers("foreign_user") })).status).toBe(403);
    expect((await app.request("/api/push/register", { ...renewal, headers: {
      ...headers("shared_actor"), "x-platform-preview-terminal": access!,
    } })).status).toBe(403);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("delivery", "ios", "owner_a", "private-phone-identity");
  });

  it("rejects invalid and oversized bodies before touching storage", async () => {
    const pushAdapter = createPushAdapter({ tokens: null });
    adapters.push(pushAdapter);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const register = vi.spyOn(pushAdapter, "registerToken");
    const remove = vi.spyOn(pushAdapter, "removeToken");
    const status = vi.spyOn(pushAdapter, "getRegistrationStatus");
    const refresh = vi.spyOn(pushAdapter, "refreshToken");
    const app = createApp(homePath, pushAdapter);

    expect((await app.request("/api/push/register", pushRequest("POST", { platform: "ios" }))).status).toBe(400);
    expect((await app.request("/api/push/register", pushRequest("DELETE", {}))).status).toBe(400);
    const oversized = JSON.stringify({ token: "x".repeat(5_000) });
    expect((await app.request("/api/push/register", pushRequest("DELETE", oversized))).status).toBe(413);
    for (const invalid of [{}, { token: "" }, { token: "phone", ownerId: "foreign" }, "not json"]) {
      expect((await app.request("/api/push/status", pushRequest("POST", invalid))).status).toBe(400);
    }
    expect((await app.request("/api/push/status", pushRequest("POST", oversized))).status).toBe(413);
    for (const extra of [{ identity: "x".repeat(513) }, { mode: "unexpected" }, { identity: "" }]) {
      expect((await app.request("/api/push/register", pushRequest("POST", { token: "delivery", platform: "ios", ...extra }))).status).toBe(400);
    }
    expect(register).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fails closed before storage when an authenticated runtime has no configured owner", async () => {
    vi.stubEnv("MATRIX_USER_ID", "");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "");
    const push = createPushAdapter({ tokens: null });
    adapters.push(push);
    const status = vi.spyOn(push, "getRegistrationStatus").mockResolvedValue({ enabled: true, registered: true });
    const response = await createApp(homePath, push).request("/api/push/status", pushRequest("POST", { token: "phone" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Push registration unavailable" });
    expect(status).not.toHaveBeenCalled();
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
    const status = await app.request("/api/push/status", pushRequest("POST", { token: "ExponentPushToken[phone]" }));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ error: "Push registration unavailable" });
  });

  it("returns a generic 500 without the database error when storage fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = {
      register: async () => { throw new Error("connection to 10.0.0.5 refused"); },
      refresh: async () => { throw new Error("connection to 10.0.0.5 refused"); },
      remove: async () => { throw new Error("connection to 10.0.0.5 refused"); },
      status: async () => { throw new Error("connection to 10.0.0.5 refused"); },
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
    const status = await app.request("/api/push/status", pushRequest("POST", { token: "ExponentPushToken[phone]" }));
    expect(status.status).toBe(500);
    expect(await status.json()).toEqual({ error: "Push registration failed" });
  });
});
