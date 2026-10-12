import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AccountDeletionRepository } from "../../packages/platform/src/account-deletion/repository.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { createFundedHostConfigRoutes, loadFundedHostConfig, FundedHostConfigResponseSchema } from "../../packages/platform/src/funded-host-config.js";
import { registerFundedHostConfigRoutes } from "../../packages/platform/src/funded-host-config-registration.js";
import { buildPlatformSyncVerificationToken, buildPlatformRuntimeVerificationToken, buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const machineId = "12345678-1234-4234-8234-123456789abc";
const secret = "strong-platform-secret-for-test-only";
const now = "2026-10-08T12:00:00.000Z";
const origin = "https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app";
const env = {
  MATRIX_FUNDED_HOST_CONFIG_ENABLED: "true", MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: machineId,
  MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: "2026-10-09T12:00:00.000Z",
  MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA: "a".repeat(40),
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true", MATRIX_FUNDED_AI_RELAY_URL: origin,
};
const identity = { handle: "alice", machineId, runtimeSlot: "primary" };
const headers = () => ({ authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 2)}`,
  "x-matrix-machine-id": machineId, "x-matrix-runtime-slot": "primary", "x-matrix-runtime-token-epoch": "2" });

describe("funded host configuration", () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { ...identity, clerkUserId: "user_alice", status: "running",
      runtimeTokenEpoch: 2, activationState: "authorized", provisionedAt: now });
    await db.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]) }).execute();
    await db.executor.insertInto("ai_funded_runtime_policies").values({ machine_id: machineId,
      owner_id: "user_alice", runtime_slot: "primary", enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), monthly_budget_microusd: 100,
      expires_at: null, next_issue_at: now, revision: 0, created_at: now, updated_at: now }).execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.restoreAllMocks(); });
  function app(overrides: NodeJS.ProcessEnv = {}, clock = () => new Date(now)) {
    return new Hono().route("/internal/containers/:handle", createFundedHostConfigRoutes({
      db, platformSecret: secret, config: loadFundedHostConfig({ ...env, ...overrides }, new Date(now)), now: clock,
    }));
  }
  async function request(overrides: Record<string, string> = {}, options: NodeJS.ProcessEnv = {}) {
    return app(options).request("/internal/containers/alice/funded-host-config", { headers: { ...headers(), ...overrides } });
  }
  async function seedReservation(status: string) {
    await db.executor.insertInto("ai_runtime_credentials").values({ token_id: "token_test", token_hash: "a".repeat(64),
      owner_id: "user_alice", machine_id: machineId, runtime_slot: "primary", audience: "matrix-funded-relay", scope: "ai:invoke",
      issued_at: now, expires_at: now, revoked_at: null }).execute();
    await db.executor.insertInto("ai_funded_usage_reservations").values({ reservation_id: "reservation_test",
      request_id: "request_test", payload_hash: "b".repeat(64), authorization_response: "{}", settlement_response: null,
      finalization_mode: null, manual_review_evidence_ref: null, manual_review_actor: null, manual_reviewed_at: null,
      start_response: null, release_response: null, release_reason: null, token_id: "token_test", owner_id: "user_alice",
      machine_id: machineId, runtime_slot: "primary", model_id: "anthropic/claude-sonnet-5", reserved_microusd: 1,
      promotional_reserved_microusd: null, addon_reserved_microusd: null, actual_microusd: null, resolved_model: null,
      pricing_version: null, period_start: now, status, created_at: now, started_at: null, expires_at: now,
      settled_at: null, released_at: null }).execute();
  }
  it("returns exact short-lived epoch-bound fields without financial writes", async () => {
    const before = await db.executor.selectFrom("ai_funded_runtime_policies").selectAll().execute();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    const value = await response.json();
    expect(value).toEqual({ contractVersion: 1, kind: "matrix-funded-host-config", source: "platform",
      sourceSha: "a".repeat(40), issuedAt: now, expiresAt: "2026-10-08T12:00:30.000Z",
      identity: { ...identity, runtimeTokenEpoch: 2 }, configuration: {
        MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RELAY_URL: origin,
        MATRIX_FUNDED_AI_RUNTIME_TOKEN: buildPlatformRuntimeVerificationToken(identity, secret, 2),
        MATRIX_FUNDED_AI_PLATFORM_URL: "https://app.matrix-os.com",
      } });
    expect(FundedHostConfigResponseSchema.safeParse({ ...value, arbitraryCommand: "whoami" }).success).toBe(false);
    expect(await db.executor.selectFrom("ai_funded_runtime_policies").selectAll().execute()).toEqual(before);
    for (const table of ["ai_funded_credit_ledger", "ai_runtime_credentials", "ai_funded_usage_reservations", "ai_funded_runtime_balances"] as const) {
      expect(await db.executor.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });
  it.each([
    { authorization: `Bearer ${buildPlatformVerificationToken("alice", secret)}` },
    { authorization: `Bearer ${buildPlatformRuntimeVerificationToken(identity, secret, 2)}` },
    { authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 1)}` },
    { authorization: `Bearer ${buildPlatformSyncVerificationToken({ ...identity, runtimeSlot: "pr-1" }, secret, 2)}` },
    { authorization: `Bearer ${buildPlatformSyncVerificationToken({ ...identity, machineId: "87654321-1234-4234-8234-123456789abc" }, secret, 2)}` },
    { "x-matrix-machine-id": "87654321-1234-4234-8234-123456789abc" },
    { "x-matrix-runtime-token-epoch": "1" },
    { authorization: "Bearer " + "f".repeat(64) },
  ])("rejects nonmatching machine/slot/epoch token %j", async (value) => {
    expect((await request(value)).status).toBe(401);
  });
  it("rejects an invalid machine HMAC before database readiness or transaction acquisition", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(db, "ready")!;
    const ready = vi.fn(() => { throw new Error("must not access database readiness"); });
    const transaction = vi.spyOn(db.kysely, "transaction");
    Object.defineProperty(db, "ready", { configurable: true, get: ready });
    try {
      const response = await request({ authorization: "Bearer " + "f".repeat(64) });
      expect(response.status).toBe(401);
      expect(ready).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally { Object.defineProperty(db, "ready", descriptor); }
  });
  it("rejects a coherent old-epoch HMAC through the fresh database epoch check", async () => {
    const transaction = vi.spyOn(db.kysely, "transaction");
    const response = await request({
      authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 1)}`,
      "x-matrix-runtime-token-epoch": "1",
    });
    expect(response.status).toBe(401);
    expect(transaction).toHaveBeenCalledOnce();
  });
  it.each(["x-matrix-machine-id", "x-matrix-runtime-slot", "x-matrix-runtime-token-epoch", "authorization"])("requires %s", async (field) => {
    const fields: Record<string, string> = headers(); delete fields[field];
    expect((await app().request("/internal/containers/alice/funded-host-config", { headers: fields })).status).toBe(400);
  });
  it.each(["02", "0", "2147483648", "NaN"])("rejects epoch syntax %s", async (epoch) => {
    expect((await request({ "x-matrix-runtime-token-epoch": epoch })).status).toBe(400);
  });
  it.each(["suspended", "failed", "deleted", "resizing"])("rejects %s machines", async (status) => {
    await db.executor.updateTable("user_machines").set({ status }).execute();
    expect((await request()).status).toBe(401);
  });
  it.each([{ deleted_at: now }, { provisioning_class: "preview" }, { activation_state: "awaiting_billing" },
    { runtime_slot: "pr-1" }])("rejects inadmissible machine %j", async (values) => {
    await db.executor.updateTable("user_machines").set(values).execute();
    expect((await request()).status).toBe(401);
  });
  it.each([{ MATRIX_FUNDED_HOST_CONFIG_ENABLED: "false" }, { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "" }])("defaults capability off or empty %j", async (options) => {
    expect((await request({}, options)).status).toBe(503);
  });
  it("rejects disabled or expired policy without reconciling it", async () => {
    await db.executor.updateTable("ai_funded_runtime_policies").set({ expires_at: now }).execute();
    expect((await request()).status).toBe(503);
    await db.executor.updateTable("ai_funded_runtime_policies").set({ expires_at: null, enabled: false }).execute();
    expect((await request()).status).toBe(503);
    await db.executor.updateTable("ai_funded_runtime_policies").set({ enabled: true }).execute();
    await db.executor.updateTable("ai_funded_global_policy").set({ enabled: false }).execute();
    expect((await request()).status).toBe(503);
  });
  it("fails closed when policy model lists do not overlap supported Chat models", async () => {
    await db.executor.updateTable("ai_funded_runtime_policies").set({ allowed_model_ids: JSON.stringify(["typesafe/jev"]) }).execute();
    expect((await request()).status).toBe(503);
  });
  it.each(["reserved", "starting", "in_flight", "settling", "expired", "releasing"])("defers %s obligations without altering them", async (status) => {
    await seedReservation(status);
    const before = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute();
    expect((await request()).status).toBe(503);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual(before);
  });
  it("retains unknown obligations on the machine when reservation ownership metadata differs", async () => {
    await seedReservation("in_flight");
    await db.executor.updateTable("ai_funded_usage_reservations").set({ owner_id: "former_owner" }).execute();
    const before = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute();
    expect((await request()).status).toBe(503);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual(before);
  });
  it("defers corrupt settled status with no established cost", async () => {
    await seedReservation("settled");
    expect((await request()).status).toBe(503);
  });
  it.each(["settled", "released"])("does not block financially closed %s reservations", async status => {
    await seedReservation(status);
    if (status === "settled") await db.executor.updateTable("ai_funded_usage_reservations").set({ actual_microusd: 0 }).execute();
    expect((await request()).status).toBe(200);
  });
  it.each(["scheduled", "processing", "completed"])("defers owner deletion in %s state without mutating its job", async status => {
    const deletionSecret = "existing-account-deletion-secret-test-only";
    const repository = new AccountDeletionRepository(db.kysely, { secret: deletionSecret, now: () => new Date(now) });
    await repository.accept({ clerkUserId: "user_alice", appleTokens: [] }, false);
    await db.executor.updateTable("account_deletion_jobs").set({ status }).execute();
    const before = await db.executor.selectFrom("account_deletion_jobs").selectAll().execute();
    const orchestrator = { listAll: vi.fn().mockReturnValue([]) } as unknown as Orchestrator;
    const server = createApp({ db, orchestrator, platformSecret: secret, env: { ...env,
      ACCOUNT_DELETION_SECRET: deletionSecret,
      MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() + 86_400_000).toISOString() } });
    try {
      expect((await server.request("https://app.matrix-os.com/internal/containers/alice/funded-host-config", { headers: headers() })).status).toBe(503);
      expect(await db.executor.selectFrom("account_deletion_jobs").selectAll().execute()).toEqual(before);
    } finally { await server.shutdownPostHog(); }
  });
  it("mounts strong machine auth before canonical app-domain tenant routing", async () => {
    const orchestrator = { provision: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), upgrade: vi.fn(),
      rollingRestart: vi.fn(), getInfo: vi.fn(), getImage: vi.fn(), listAll: vi.fn().mockReturnValue([]), syncStates: vi.fn() } as Orchestrator;
    const server = createApp({ db, orchestrator, platformSecret: secret, env: { ...env,
      MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() + 86_400_000).toISOString() } });
    const response = await server.request("https://app.matrix-os.com/internal/containers/alice/funded-host-config", { headers: headers() });
    expect(response.status).toBe(200);
    expect(FundedHostConfigResponseSchema.safeParse(await response.json()).success).toBe(true);
    const invalid = await server.request("https://app.matrix-os.com/internal/containers/alice/funded-host-config", {
      headers: { ...headers(), authorization: `Bearer ${secret}` } });
    expect(invalid.status).toBe(400);
    await server.shutdownPostHog();

  });
  it("does not accept a different machine merely because it shares an owner", async () => {
    const response = await app({ MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "87654321-1234-4234-8234-123456789abc" })
      .request("/internal/containers/alice/funded-host-config", { headers: headers() });
    expect(response.status).toBe(401);
  });
  it("bounds expiry by runtime policy", async () => {
    await db.executor.updateTable("ai_funded_runtime_policies").set({ expires_at: "2026-10-08T12:00:10.000Z" }).execute();
    expect((await (await request()).json()).expiresAt).toBe("2026-10-08T12:00:10.000Z");
  });
  it("permits the canonical GLM Chat policy while rejecting stale aliases", async () => {
    for (const model of ["@cf/zai-org/glm-5.3-flash", "z-ai/glm-5.3-flash"]) {
      await db.executor.updateTable("ai_funded_runtime_policies").set({ allowed_model_ids: JSON.stringify([model]) }).execute();
      await db.executor.updateTable("ai_funded_global_policy").set({ allowed_model_ids: JSON.stringify([model]) }).execute();
      expect((await request()).status).toBe(model.startsWith("@cf/") ? 200 : 503);
    }
  });
  it("rejects unsafe injected config and freezes its registered cohort", async () => {
    const config = loadFundedHostConfig(env, new Date(now));
    if (!config.enabled) throw new Error("test fixture disabled");
    expect(() => createFundedHostConfigRoutes({ db, platformSecret: secret, now: () => new Date(now),
      config: { ...config, validThrough: "2027-10-09T12:00:00.000Z" } })).toThrow();
    const server = new Hono().route("/internal/containers/:handle", createFundedHostConfigRoutes({
      db, platformSecret: secret, config, now: () => new Date(now) }));
    (config.machineIds as string[]).splice(0);
    expect((await server.request("/internal/containers/alice/funded-host-config", { headers: headers() })).status).toBe(200);
  });
  it("validates nested response fields and expiry strictly", async () => {
    const value = await (await request()).json();
    for (const changed of [
      { ...value, expiresAt: "2026-10-08T12:00:31.000Z" },
      { ...value, expiresAt: now },
      { ...value, sourceSha: "invalid" },
      { ...value, identity: { ...value.identity, runtimeSlot: "pr-1" } },
      { ...value, configuration: { ...value.configuration, PROVIDER_TOKEN: "not-allowed" } },
      { ...value, configuration: { ...value.configuration, MATRIX_FUNDED_AI_ENABLED: true } },
    ]) expect(FundedHostConfigResponseSchema.safeParse(changed).success).toBe(false);
  });
  it("requires complete valid registration dependencies", () => {
    expect(() => createFundedHostConfigRoutes({ db, platformSecret: "short", config: loadFundedHostConfig(env, new Date(now)) })).toThrow();
  });
  it("returns generic errors and no secrets on DB failures", async () => {
    vi.spyOn(db.kysely, "transaction").mockImplementation(() => { throw new Error("postgres credential secret"); });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("credential");
  });
  it("rejects query payloads, non-primary slots and invalid handle", async () => {
    expect((await app().request("/internal/containers/alice/funded-host-config?command=x", { headers: headers() })).status).toBe(400);
    expect((await request({ "x-matrix-runtime-slot": "pr-1" })).status).toBe(400);
    expect((await app().request("/internal/containers/ALICE/funded-host-config", { headers: headers() })).status).toBe(400);
  });
  it("bounds expiry by reviewed config and policy then refuses stale config", async () => {
    const configExpiry = "2026-10-08T12:00:15.000Z";
    const response = await request({}, { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: configExpiry });
    expect((await response.json()).expiresAt).toBe(configExpiry);
    let instant = new Date(now);
    const server = app({}, () => instant);
    instant = new Date("2026-10-09T12:00:00.000Z");
    expect((await server.request("/internal/containers/alice/funded-host-config", { headers: headers() })).status).toBe(503);
  });
});

describe("funded host config environment", () => {
  it("defaults disabled and ignores unused config", () => expect(loadFundedHostConfig({})).toEqual({ enabled: false }));
  it.each([now, "2026-10-08T11:59:59.999Z"])("disables a valid expired cohort at startup: %s", expiry => {
    expect(loadFundedHostConfig({ ...env, MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: expiry }, new Date(now)))
      .toEqual({ enabled: false });
  });
  it("keeps unrelated HTTP routes available without accessing the DB when a cohort expired before startup", async () => {
    const accessed = vi.fn(() => { throw new Error("expired capability must not access DB"); });
    const db = new Proxy({} as PlatformDB, { get: accessed });
    const server = new Hono().get("/health", c => c.json({ status: "ok" }))
      .get("/unrelated", c => c.text("available"));
    registerFundedHostConfigRoutes(server, { db, platformSecret: secret, env: { ...env,
      MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: new Date(Date.now() - 1000).toISOString() } });
    expect((await server.request("/health")).status).toBe(200);
    expect(await (await server.request("/unrelated")).text()).toBe("available");
    expect((await server.request("/internal/containers/alice/funded-host-config", { headers: headers() })).status).toBe(404);
    expect(accessed).not.toHaveBeenCalled();
  });
  it.each([{ MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA: "" }, { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: machineId + "," + machineId }])
    ("does not let expiry mask malformed configuration %j", invalid => {
      expect(() => loadFundedHostConfig({ ...env, ...invalid, MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: now }, new Date(now))).toThrow();
    });
  it.each([
    { MATRIX_FUNDED_HOST_CONFIG_ENABLED: "yes" }, { MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" },
    { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: machineId + "," + machineId },
    { MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS: "not-uuid" },
    { MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA: "" },
    { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: "invalid" },
    { MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH: "2027-10-08T00:00:00.000Z" },
    ...["http://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app", "https://matrix-ai-relay-preview-x-ey.a.run.app",
      "https://candidate---matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app", "https://matrix-ai-relay-jqxkjdhtkq-ey.a.run.app", "https://example.com", origin + "/path", origin + "?x=1"].map(url => ({ MATRIX_FUNDED_AI_RELAY_URL: url })),
  ])("rejects unreviewed unsafe configuration %j", (value) => {
    expect(() => loadFundedHostConfig({ ...env, ...value }, new Date(now))).toThrow();
  });
});
