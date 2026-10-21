import { KyselyPGlite } from "kysely-pglite";
import { sql } from "kysely";
import { recoverTerminalOutcomes } from "../../packages/platform/src/ai-funded-recovery-lifecycle.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createAiFundedRelayRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { createFundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const modelId = "@cf/zai-org/glm-5.3-flash";
const identity = { ownerId: "terminal_owner", machineId: "terminal_machine", runtimeSlot: "primary" };
const controlToken = "terminal-test-control-token-32-characters";
const initialTime = "2026-09-10T12:00:00.000Z";

describe("durable unknown terminal outcomes across Relay and Platform", () => {
  let db: PlatformDB;
  let instance: Awaited<ReturnType<typeof createTestPlatformDb>>["instance"];
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };
  let app: Hono;
  let relay: ReturnType<typeof createFundedRelay> | undefined;
  const makeRepo = () => createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
    now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
  const authorize = (requestId: string, maximum = 100) => repo.authorize({ credential: credential.token,
    requestId, modelId, billingMode: "usage", maxCostMicrousd: maximum });
  const row = () => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("created_at").executeTakeFirstOrThrow();
  const finance = async () => ({
    balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
  });
  const terminal = async (body: unknown, token = controlToken) => app.request("/internal/ai/funded/terminal", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const receipt = async () => {
    const saved = await row();
    return { contractVersion: 1, reservationId: saved.reservation_id, tokenId: saved.token_id,
      requestId: saved.request_id, ...identity, startedAt: saved.started_at!, expiresAt: saved.expires_at,
      executionId: "relay-execution-1", terminalState: "failed", terminalAt: new Date(Date.parse(saved.started_at!) + 30_000).toISOString(),
      outcome: "usage_unknown" };
  };
  beforeEach(async () => {
    ({ db, instance } = await createTestPlatformDb()); clock = new Date(initialTime); repo = makeRepo();
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "terminal",
      runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test", provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "terminal-grant", identity, kind: "addon_grant", amountMicrousd: 1_000_000, sourceReference: "fixture" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
    app = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ repository: repo, relayControlToken: controlToken }));
  });
  afterEach(async () => { await relay?.close(); relay = undefined; vi.restoreAllMocks(); await destroyTestPlatformDb(db); });

  it("a stalled GLM dispatch returns504, persists unknown instead of semantic503 retries, and recovers after expiry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cfg = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
      MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS: "1000",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
      PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: controlToken, AI_RELAY_METADATA_SECRET: "m".repeat(32) })!;
    const platformStatuses: { path: string; status: number }[] = [];
    const platform = createFundedPlatformClient({ ...cfg, fetch: async (url, init) => {
      const response = await app.request(String(url), init);
      platformStatuses.push({ path: new URL(String(url)).pathname, status: response.status }); return response;
    } });
    let dispatches = 0;
    relay = createFundedRelay({ ...cfg, platformClient: platform, now: () => new Date(clock), requestIdFactory: () => "stalled-request",
      fetch: async (_url, init) => { dispatches++; return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }); } });
    const relayApp = new Hono(); relay.register(relayApp);
    const result = await relayApp.request("/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 256, messages: [{ role: "user", content: "Synthetic timeout fixture" }] }) });
    expect(result.status).toBe(504); expect(dispatches).toBe(1); await relay.close();
    const old = await row();
    // Legacy conservative usage settlement really rejects503; the durable terminal path must avoid it.
    await expect(repo.finalizeReservation({ reservationId: old.reservation_id, tokenId: old.token_id, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(platformStatuses.filter((r) => r.path.endsWith("/finalize"))).toEqual([]);
    expect(platformStatuses.filter((r) => r.path.endsWith("/terminal"))).toEqual([{ path: "/internal/ai/funded/terminal", status: 200 }]);
    expect(old).toMatchObject({ status: "in_flight", actual_microusd: null });
    expect(JSON.parse(old.terminal_outcome!)).toMatchObject({ request: { requestId: "stalled-request", outcome: "usage_unknown" } });
    const before = await finance(); clock = new Date(Date.parse(initialTime) + 17 * 60_000);
    const next = await authorize("after-terminal"); expect(next.authorized).toBe(true);
    const recovered = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", old.reservation_id).executeTakeFirstOrThrow();
    expect(JSON.parse(recovered.execution_admission_release!)).toMatchObject({ kind: "relay_terminal_v2" });
    expect(recovered).toMatchObject({ status: "in_flight", actual_microusd: null, reserved_microusd: old.reserved_microusd });
    // New work adds its own hold, while recovery retains the entire old liability.
    expect((await finance()).ledger).toEqual(before.ledger);
  });

  it("authenticates and binds immutable unknown receipts, surviving repository recreation and late exact settlement", async () => {
    const auth = await authorize("unknown-request"); await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
    clock = new Date(Date.parse(initialTime) + 30_000); const proof = await receipt(); const before = await finance();
    expect((await terminal(proof, "forged")).status).toBe(401);
    expect((await terminal({ ...proof, ownerId: "other" })).status).toBe(404);
    expect((await terminal({ ...proof, terminalAt: "2026-09-11T00:00:00.000Z" })).status).toBe(409);
    expect((await terminal(proof)).status).toBe(200); const first = await row();
    expect(await finance()).toEqual(before);
    // Restore actual persisted database bytes, then run production startup checks.
    const persisted = await instance.client.dumpDataDir("none"); await db.destroy();
    instance = await KyselyPGlite.create({ loadDataDir: persisted }); db = createPlatformDb({ dialect: instance.dialect }); await db.ready;
    repo = makeRepo(); app = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ repository: repo, relayControlToken: controlToken }));
    expect((await terminal(proof)).status).toBe(200); expect((await row()).terminal_outcome).toBe(first.terminal_outcome);
    expect((await terminal({ ...proof, executionId: "other-run" })).status).toBe(409);
    await expect(authorize("too-early")).rejects.toMatchObject({ code: "rate_limited" });
    await repo.finalizeReservation({ reservationId: first.reservation_id, tokenId: first.token_id, mode: "exact", actualCostMicrousd: 10 });
    const exact = await row(); expect((await terminal(proof)).status).toBe(200);
    expect(await row()).toEqual(exact);
  });
  it.each(["missing-proof", "minimum-age", "terminal-grace", "unexpired", "liability-cap", "machine-identity", "malformed-proof"])("keeps admission and every financial byte for automatic %s guard", async (guard) => {
    const auth = await authorize("guard-request", guard === "liability-cap" ? 500_001 : 100);
    await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
    if (guard === "unexpired") await db.executor.updateTable("ai_funded_usage_reservations").set({ expires_at: "2026-09-10T12:30:00.000Z" }).execute();
    clock = new Date(Date.parse(initialTime) + (guard === "terminal-grace" ? 16 * 60_000 : 30_000));
    const proof = await receipt(); if (guard === "terminal-grace") proof.terminalAt = clock.toISOString();
    if (guard !== "missing-proof") expect((await terminal(proof)).status).toBe(200);
    clock = new Date(Date.parse(initialTime) + (guard === "minimum-age" ? 15 * 60_000 : 16 * 60_000));
    if (guard === "machine-identity") await db.executor.updateTable("user_machines").set({ activation_state: "cancelled" }).where("machine_id", "=", identity.machineId).execute();
    if (guard === "malformed-proof") await db.executor.updateTable("ai_funded_usage_reservations").set({ terminal_outcome: "{}" }).execute();
    const before = await finance();
    const recover = () => db.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
      await recoverTerminalOutcomes(trx.executor, identity.ownerId, clock);
    });
    if (["machine-identity", "malformed-proof"].includes(guard)) await expect(recover()).rejects.toThrow(); else await recover();
    expect((await row()).execution_admission_release).toBeNull(); expect(await finance()).toEqual(before);
  });

  it("saves exactly two unknown obligations, validates their audits and blocks a third terminal obligation", async () => {
    for (let index = 0; index < 3; index++) {
      const auth = await authorize(`unknown-${index}`, 100);
      const start = await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
      clock = new Date(clock.getTime() + 30_000);
      expect((await terminal({ contractVersion: 1, ...identity, reservationId: start.reservationId, requestId: start.requestId,
        tokenId: start.tokenId, startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: `execution-${index}`,
        terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" })).status).toBe(200);
      clock = new Date(clock.getTime() + 17 * 60_000);
    }
    const before = await finance();
    await expect(authorize("fourth-unknown")).rejects.toMatchObject({ code: "rate_limited" });
    const saved = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("request_id").execute();
    expect(saved.filter((r) => r.execution_admission_release !== null).map((r) => r.execution_recovery_slot).sort()).toEqual([0, 1]);
    expect(saved[2].execution_admission_release).toBeNull();
    const after = await finance();
    // Existing interactive priority bookkeeping refreshes balance updated_at even on slot refusal.
    expect({ ...after, balances: after.balances.map(({ updated_at: _at, ...r }) => r) })
      .toEqual({ ...before, balances: before.balances.map(({ updated_at: _at, ...r }) => r) });
    const audit = JSON.parse(saved[0].execution_admission_release!); audit.request.machineId = "forged-machine";
    await db.executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: JSON.stringify(audit) }).where("reservation_id", "=", saved[0].reservation_id).execute();
    await expect(authorize("corrupt-audit")).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("records a late unknown receipt after exact usage without changing financial settlement, and replays it", async () => {
    const auth = await authorize("exact-first"); await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
    clock = new Date(Date.parse(initialTime) + 30_000); const proof = await receipt();
    await repo.finalizeReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, mode: "exact", actualCostMicrousd: 10 });
    const before = await row(); const financial = await finance();
    const accepted = await (await terminal(proof)).json(); clock = new Date(clock.getTime() + 60_000);
    expect(await (await terminal(proof)).json()).toEqual(accepted);
    expect(await row()).toEqual({ ...before, terminal_outcome: (await row()).terminal_outcome });
    expect((await row()).terminal_outcome).not.toBeNull(); expect(await finance()).toEqual(financial);
  });

});
