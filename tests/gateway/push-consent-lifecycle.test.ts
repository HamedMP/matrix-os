import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Kysely, sql } from "kysely";
import { createPostHogErrorTracker } from "@matrix-os/observability";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createPushAdapter, type PushAdapter } from "../../packages/gateway/src/channels/push.js";
import { createInteractionLogger } from "../../packages/gateway/src/logger.js";
import { createPushTokenStore, MAX_PUSH_CONSENTS_PER_OWNER } from "../../packages/gateway/src/notifications/push-tokens.js";
import { bootstrapNotificationDatabase, type NotificationDatabase } from "../../packages/gateway/src/notifications/schema.js";
import { registerSystemOperatorRoutes } from "../../packages/gateway/src/server/system-operator-routes.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const DAY = 86_400_000;
const IDENTITY = "ExponentPushToken[original-install]";
const DELIVERY = "ExponentPushToken[rotated-delivery]";
const AUTH = "consent-lifecycle-test-bearer";

describe("phone consent and expiring delivery registration", () => {
  let db: Kysely<NotificationDatabase>;
  let app: Hono;
  let push: PushAdapter;
  let homePath: string;
  let now: number;

  const request = (path: string, body: unknown, method = "POST") => app.request(path, {
    method, headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const register = () => request("/api/push/register", { token: IDENTITY, platform: "ios" });
  const refresh = (token = IDENTITY) => request("/api/push/register", { token, platform: "ios", identity: IDENTITY, mode: "refresh" });
  async function status(expected: { enabled: boolean; registered: boolean }, identity = IDENTITY) {
    const response = await request("/api/push/status", { token: identity });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  }

  function mount(adapter: PushAdapter): Hono {
    const routes = new Hono();
    routes.use("*", authMiddleware(AUTH));
    registerSystemOperatorRoutes({
      app: routes, homePath, model: undefined, runningVersion: "test", pushAdapter: adapter,
      interactionLogger: createInteractionLogger(homePath),
      posthogErrorTracker: createPostHogErrorTracker({ service: "matrix-gateway", env: {} }),
      ownerTelemetryDistinctId: "test", upgradeBodyLimit: bodyLimit({ maxSize: 4096 }),
      logBestEffortFailure: (_context, error) => { throw error; },
    });
    return routes;
  }

  beforeEach(async () => {
    vi.stubEnv("MATRIX_USER_ID", "owner_a");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "owner_a");
    vi.stubEnv("MATRIX_AUTH_TOKEN", AUTH);
    homePath = await mkdtemp(join(tmpdir(), "push-consent-"));
    const pg = await createTestPGlite();
    db = new Kysely<NotificationDatabase>({ dialect: pg.dialect });
    await bootstrapNotificationDatabase(db);
    now = Date.UTC(2026, 10, 1);
    push = createPushAdapter({ tokens: createPushTokenStore(db), ownerId: "owner_a", now: () => now });
    app = mount(push);
  });

  afterEach(async () => {
    push.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.destroy();
    await rm(homePath, { recursive: true, force: true });
  });

  it("restores delivery after the 30-day sweep without requiring another opt-in", async () => {
    expect((await register()).status).toBe(200);
    now += 31 * DAY;
    await push.sweepExpiredTokens();
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);

    await status({ enabled: true, registered: false });
    const refreshed = await refresh();
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ ok: true, registered: true });
    await status({ enabled: true, registered: true });
  });

  it("restores delivery after real Expo DeviceNotRegistered cleanup and a gateway restart", async () => {
    expect((await register()).status).toBe(200);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
    }), { status: 200 }));
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Approval needed" });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
    push.dispose();
    push = createPushAdapter({ tokens: createPushTokenStore(db), ownerId: "owner_a", now: () => now });
    app = mount(push);

    await status({ enabled: true, registered: false });
    expect((await refresh()).status).toBe(200);
    await status({ enabled: true, registered: true });
  });

  it("keeps explicit opt-out off even when a refresh was prepared before the opt-out", async () => {
    expect((await register()).status).toBe(200);
    await status({ enabled: true, registered: true });
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    now += 31 * DAY;
    await push.sweepExpiredTokens();

    const staleRefresh = await refresh();
    expect(staleRefresh.status).toBe(200);
    expect(await staleRefresh.json()).toEqual({ ok: true, registered: false });
    await status({ enabled: false, registered: false });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);
  });

  it.each([["retained", IDENTITY], ["rotated", DELIVERY]])("rejects older automatic registration of a %s token after explicit off", async (_label, token) => {
    expect((await register()).status).toBe(200);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: true });
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);

    const legacy = await request("/api/push/register", { token, platform: "ios" });
    expect(legacy.status).toBe(409);
    await status({ enabled: false, registered: false });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);

    // Only a deliberate new-protocol enable can replace the off decision.
    expect((await request("/api/push/register", { token, identity: IDENTITY, platform: "ios", mode: "enable" })).status).toBe(200);
    await status({ enabled: true, registered: true });
    expect((await request("/api/push/register", { token, platform: "ios" })).status).toBe(200);
  });

  it("allows old-client recovery of known on consent but refuses an unknown rotation after off history", async () => {
    expect((await register()).status).toBe(200);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: true });
    await db.deleteFrom("notification_push_tokens").execute();
    expect((await request("/api/push/register", { token: DELIVERY, platform: "ios" })).status).toBe(200);
    await status({ enabled: true, registered: true });
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    const unknown = await request("/api/push/register", { token: "ExponentPushToken[unknown-rotation]", platform: "ios" });
    expect(unknown.status).toBe(409);
    await status({ enabled: false, registered: false });
  });

  it.each([["stable identity", IDENTITY], ["legacy delivery token", DELIVERY]])("revokes rotated delivery using the %s", async (_label, revokeToken) => {
    expect((await register()).status).toBe(200);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: true });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([{ token: DELIVERY }]);
    await status({ enabled: true, registered: true });

    expect((await request("/api/push/register", { token: revokeToken }, "DELETE")).status).toBe(200);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: false });
    await status({ enabled: false, registered: false });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([]);
  });

  it("does not infer consent for a new computer from a cached identity alone", async () => {
    await status({ enabled: false, registered: false });
    expect(await (await refresh()).json()).toEqual({ ok: true, registered: false });
    await status({ enabled: false, registered: false });
  });

  it("migrates real legacy rows, including expired rows, without enrolling missing or foreign identities", async () => {
    // Roll back only the additive consent migration to reconstruct the real v1
    // table created by the production bootstrap, then feed it legacy records.
    await db.schema.dropTable("notification_push_consents").ifExists().execute();
    await sql`ALTER TABLE notification_push_tokens DROP COLUMN IF EXISTS identity`.execute(db);
    await db.deleteFrom("notification_schema_migrations").where("version", "=", 4).execute();
    const old = new Date(now - 31 * DAY);
    await db.insertInto("notification_push_tokens").values([
      { token: IDENTITY, owner_id: "owner_a", platform: "ios", created_at: old, last_seen_at: old },
      { token: "ExponentPushToken[foreign]", owner_id: "owner_b", platform: "ios", created_at: old, last_seen_at: old },
    ]).execute();
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [4] });
    await push.sweepExpiredTokens();

    await status({ enabled: true, registered: false });
    await status({ enabled: false, registered: false }, "ExponentPushToken[foreign]");
    await status({ enabled: false, registered: false }, "ExponentPushToken[unknown]");
    expect(await (await refresh()).json()).toEqual({ ok: true, registered: true });
  });

  it("does not overwrite explicit off during an idempotent legacy backfill", async () => {
    expect((await register()).status).toBe(200);
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    await db.insertInto("notification_push_tokens").values({
      token: IDENTITY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    await db.deleteFrom("notification_schema_migrations").where("version", "=", 4).execute();
    await bootstrapNotificationDatabase(db);

    await status({ enabled: false, registered: true });
    const send = vi.spyOn(globalThis, "fetch");
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Approval needed" });
    expect(send).not.toHaveBeenCalled();
    expect(await (await refresh()).json()).toEqual({ ok: true, registered: false });
  });

  it("reconciles legacy delivery writes after migration 4 was already recorded", async () => {
    for (const token of [IDENTITY, DELIVERY]) {
      await db.insertInto("notification_push_tokens").values({
        token, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
      }).execute();
      expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
      await status({ enabled: true, registered: true }, token);
    }
  });

  it("reconnects a known rotated legacy token to the retained identity after cleanup", async () => {
    expect((await register()).status).toBe(200);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: true });
    await db.deleteFrom("notification_push_tokens").execute();
    await db.insertInto("notification_push_tokens").values({
      token: DELIVERY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
    await status({ enabled: true, registered: true });
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    await status({ enabled: false, registered: false });
  });

  it("does not let an ambiguous legacy write revive an explicit opt-out", async () => {
    expect((await register()).status).toBe(200);
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    await db.insertInto("notification_push_tokens").values({
      token: DELIVERY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    expect(await bootstrapNotificationDatabase(db)).toEqual({ applied: [] });
    await status({ enabled: false, registered: false });
    await status({ enabled: false, registered: false }, DELIVERY);
    const send = vi.spyOn(globalThis, "fetch");
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Approval needed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("collapses a legacy rotation before off so a later old-writer row cannot revive delivery", async () => {
    expect((await register()).status).toBe(200);
    await db.insertInto("notification_push_tokens").values({
      token: DELIVERY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    await bootstrapNotificationDatabase(db);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: true });
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    await db.insertInto("notification_push_tokens").values({
      token: DELIVERY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    await bootstrapNotificationDatabase(db);
    const send = vi.spyOn(globalThis, "fetch");
    await push.send({ channelId: "push", chatId: "coding-agents", ownerId: "owner_a", text: "Approval needed" });
    expect(send).not.toHaveBeenCalled();
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: false });
  });

  it("revokes both retained identity and a cached legacy rotation before the first refresh", async () => {
    expect((await register()).status).toBe(200);
    await db.insertInto("notification_push_tokens").values({
      token: DELIVERY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    await bootstrapNotificationDatabase(db);
    expect((await request("/api/push/register", { token: IDENTITY, deliveryToken: DELIVERY }, "DELETE")).status).toBe(200);
    await status({ enabled: false, registered: false });
    await status({ enabled: false, registered: false }, DELIVERY);
    expect(await (await refresh(DELIVERY)).json()).toEqual({ ok: true, registered: false });
  });

  it("retains the legacy opt-out guard after the phone tombstone is capacity-evicted", async () => {
    expect((await register()).status).toBe(200);
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    for (let i = 0; i < MAX_PUSH_CONSENTS_PER_OWNER; i++) {
      now++;
      await push.registerToken(`ExponentPushToken[other-${i}]`, "ios", "owner_a");
    }
    expect(await db.selectFrom("notification_push_consents").select("identity").where("identity", "=", IDENTITY).execute()).toEqual([]);
    await db.insertInto("notification_push_tokens").values({
      token: IDENTITY, owner_id: "owner_a", platform: "ios", created_at: new Date(now), last_seen_at: new Date(now),
    }).execute();
    await bootstrapNotificationDatabase(db);
    await status({ enabled: false, registered: false });
    expect(await (await refresh()).json()).toEqual({ ok: true, registered: false });
  });

  it("rolls back a consent grant when delivery persistence fails", async () => {
    expect((await request("/api/push/register", { token: IDENTITY }, "DELETE")).status).toBe(200);
    await expect(push.registerToken("x".repeat(513), "ios", "owner_a", IDENTITY)).rejects.toThrow();
    await status({ enabled: false, registered: false });
  });

  it("keeps the previous delivery if a conditional refresh fails to persist its replacement", async () => {
    expect((await register()).status).toBe(200);
    await expect(push.refreshToken("x".repeat(513), "ios", "owner_a", IDENTITY)).rejects.toThrow();
    await status({ enabled: true, registered: true });
    expect(await db.selectFrom("notification_push_tokens").select("token").execute()).toEqual([{ token: IDENTITY }]);
  });

  it("bounds remembered phones and removes delivery for capacity-evicted consent", async () => {
    for (let i = 0; i <= MAX_PUSH_CONSENTS_PER_OWNER; i++) {
      now++;
      await push.registerToken(`ExponentPushToken[phone-${i}]`, "ios", "owner_a");
    }
    const remembered = await db.selectFrom("notification_push_consents").select("identity").execute();
    expect(remembered).toHaveLength(MAX_PUSH_CONSENTS_PER_OWNER);
    await status({ enabled: false, registered: false }, "ExponentPushToken[phone-0]");
    expect(await push.refreshToken("ExponentPushToken[phone-0]", "ios", "owner_a")).toBe(false);
  });
});
