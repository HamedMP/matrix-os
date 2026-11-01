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
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";

const modelId = "@cf/zai-org/glm-5.3-flash";
const identity = { ownerId: "terminal_owner", machineId: "terminal_machine", runtimeSlot: "primary" };
const controlToken = "terminal-test-control-token-32-characters";
const initialTime = "2026-09-10T12:00:00.000Z";
const relayConfig = () => resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
  MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS: "1000", MATRIX_FUNDED_AI_PLATFORM_TIMEOUT_MS: "500",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
  PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: controlToken, AI_RELAY_METADATA_SECRET: "m".repeat(32) })!;

describe("durable unknown terminal outcomes across Relay and Platform", () => {
  let db: PlatformDB;
  let instance: Awaited<ReturnType<typeof createTestPlatformDb>>["instance"];
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let credential: { token: string; tokenId: string };
  let app: Hono;
  let relay: ReturnType<typeof createFundedRelay> | undefined;
  const makeRepo = (inFlightTtlMs = 30 * 60_000) => createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
    now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs });
  const authorize = (requestId: string, maximum = 100) => repo.authorize({ credential: credential.token,
    requestId, modelId, billingMode: "usage", maxCostMicrousd: maximum });
  const row = () => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("created_at").executeTakeFirstOrThrow();
  const finance = async () => ({
    balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
    allowances: await db.executor.selectFrom("speech_runtime_allowances").selectAll().execute(),
    restrictions: await db.executor.selectFrom("ai_funded_credit_restrictions").selectAll().execute(),
  });
  const terminal = async (body: unknown, token = controlToken) => app.request("/internal/ai/funded/terminal", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const receipt = async () => {
    const saved = await row();
    return { contractVersion: 1, reservationId: saved.reservation_id, tokenId: saved.token_id,
      requestId: saved.request_id, ...identity, startedAt: saved.started_at!, expiresAt: saved.expires_at,
      executionId: JSON.parse(saved.start_response!).executionId ?? "relay-execution-1", terminalState: "failed", terminalAt: new Date(Date.parse(saved.started_at!) + 30_000).toISOString(),
      outcome: "usage_unknown" };
  };
  beforeEach(async () => {
    ({ db, instance } = await createTestPlatformDb()); clock = new Date(initialTime); repo = makeRepo();
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "terminal",
      runtimeSlot: identity.runtimeSlot, status: "running", imageVersion: "test", provisionedAt: clock.toISOString(), activationState: "authorized" });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 40_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: "terminal-grant", identity, kind: "addon_grant", amountMicrousd: 40_000_000, sourceReference: "fixture" });
    credential = (await repo.issueRuntimeCredential(identity)).credential;
    app = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ repository: repo, relayControlToken: controlToken }));
  });
  afterEach(async () => { await relay?.close(); relay = undefined; vi.restoreAllMocks(); await destroyTestPlatformDb(db); });

  it("releases failed A at30s before returning504 and admits B immediately before A's30minute financial expiry", async () => {
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
    let heldFinances: Awaited<ReturnType<typeof finance>>;
    relay = createFundedRelay({ ...cfg, platformClient: platform, now: () => new Date(clock), requestIdFactory: () => "stalled-request",
      fetch: async (_url, init) => { dispatches++; heldFinances = await finance();
        clock = new Date(Date.parse(initialTime) + 30_000);
        return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }); } });
    const relayApp = new Hono(); relay.register(relayApp);
    const result = await relayApp.request("/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 256, messages: [{ role: "user", content: "Synthetic timeout fixture" }] }) });
    expect(result.status).toBe(504); expect(dispatches).toBe(1);
    const old = await row();
    expect(old.expires_at).toBe("2026-09-10T12:30:00.000Z");
    expect(old.execution_admission_release).not.toBeNull();
    expect(await finance()).toEqual(heldFinances!);
    // Legacy conservative usage settlement really rejects503; the durable terminal path must avoid it.
    await expect(repo.finalizeReservation({ reservationId: old.reservation_id, tokenId: old.token_id, mode: "conservative" }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(platformStatuses.filter((r) => r.path.endsWith("/finalize"))).toEqual([]);
    expect(platformStatuses.filter((r) => r.path.endsWith("/terminal"))).toEqual([{ path: "/internal/ai/funded/terminal", status: 200 }]);
    expect(old).toMatchObject({ status: "in_flight", actual_microusd: null });
    expect(JSON.parse(old.terminal_outcome!)).toMatchObject({ request: { requestId: "stalled-request", outcome: "usage_unknown" } });
    const before = await finance();
    const next = await authorize("after-terminal"); expect(next.authorized).toBe(true);
    const nextStart = await repo.startReservation({ reservationId: next.reservation.reservationId, tokenId: credential.tokenId });
    expect(nextStart.startedAt).toBe("2026-09-10T12:00:30.000Z");
    const recovered = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", old.reservation_id).executeTakeFirstOrThrow();
    expect(JSON.parse(recovered.execution_admission_release!)).toMatchObject({ kind: "relay_terminal_v2" });
    expect(recovered).toMatchObject({ status: "in_flight", actual_microusd: null, reserved_microusd: old.reserved_microusd });
    // New work adds its own hold, while recovery retains the entire old liability.
    expect((await finance()).ledger).toEqual(before.ledger);
  });

  it("does not deliver A's final failure until the real Platform terminal transaction commits", async () => {
    const cfg = relayConfig();
    const entered = Promise.withResolvers<void>(); const commit = Promise.withResolvers<void>();
    const platform = createFundedPlatformClient({ ...cfg, fetch: async (url, init) => {
      if (String(url).endsWith("/terminal")) { entered.resolve(); await commit.promise; }
      return app.request(String(url), init);
    } });
    relay = createFundedRelay({ ...cfg, platformClient: platform, now: () => new Date(clock), requestIdFactory: () => "barrier-request",
      fetch: async () => { clock = new Date(clock.getTime() + 30_000); throw new Error("original fetch ended"); } });
    const relayApp = new Hono(); relay.register(relayApp);
    let delivered = false;
    const pending = relayApp.request("/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 256, messages: [{ role: "user", content: "Fixture" }] }) });
    void pending.then(() => { delivered = true; });
    await entered.promise; await Promise.resolve();
    expect(delivered).toBe(false);
    await expect(authorize("before-commit")).rejects.toMatchObject({ code: "rate_limited" });
    commit.resolve(); expect((await pending).status).toBe(502);
    expect((await row()).execution_admission_release).not.toBeNull();
    await expect(authorize("after-commit")).resolves.toMatchObject({ authorized: true });
  });

  it("drains confirmed stream cancellation and durable terminal publication before Relay shutdown", async () => {
    const cfg = relayConfig();
    const cancelled = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const platform = createFundedPlatformClient({ ...cfg, fetch: (url, init) => app.request(String(url), init) });
    relay = createFundedRelay({ ...cfg, platformClient: platform, now: () => new Date(clock), requestIdFactory: () => "shutdown-request",
      fetch: async () => { clock = new Date(clock.getTime() + 30_000); return new Response(new ReadableStream<Uint8Array>({
        cancel: async () => { cancelled.resolve(); await finish.promise; },
      }), { headers: { "content-type": "text/event-stream" } }); } });
    const relayApp = new Hono(); relay.register(relayApp);
    const response = await relayApp.request("/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 256, stream: true, messages: [{ role: "user", content: "Fixture" }] }) });
    expect(response.status).toBe(200);
    let closed = false; const closing = relay.close().then(() => { closed = true; });
    await cancelled.promise; await Promise.resolve();
    expect((await row()).terminal_outcome).toBeNull();
    const closedBeforeCancellation = closed;
    finish.resolve(); await closing;
    expect(closedBeforeCancellation).toBe(false);
    expect((await row()).terminal_outcome).not.toBeNull();
    expect((await row()).execution_admission_release).not.toBeNull();
  });

  it("authenticates and binds immutable unknown receipts, surviving repository recreation and late exact settlement", async () => {
    const auth = await authorize("unknown-request"); await repo.startReservation({ reservationId: auth.reservation.reservationId,
      tokenId: credential.tokenId, executionId: "relay-execution-1" });
    clock = new Date(Date.parse(initialTime) + 30_000); const proof = await receipt(); const before = await finance();
    expect((await terminal(proof, "forged")).status).toBe(401);
    expect((await terminal({ ...proof, ownerId: "other" })).status).toBe(404);
    expect((await terminal({ ...proof, terminalAt: "2026-09-11T00:00:00.000Z" })).status).toBe(409);
    expect((await terminal(proof)).status).toBe(200); const first = await row();
    expect(await finance()).toEqual(before);
    // Restore actual persisted database bytes, then run production startup checks.
    await sql`UPDATE platform_schema_revisions SET generation=20,
      fingerprint='a57002ed113b35b0d04760677d434320c1314ba60c44ebe2ea0cc1a7edb05930' WHERE scope='core'`.execute(db.executor);
    const persisted = await instance.client.dumpDataDir("none"); await db.destroy();
    instance = await KyselyPGlite.create({ loadDataDir: persisted }); db = createPlatformDb({ dialect: instance.dialect }); await db.ready;
    repo = makeRepo(); app = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ repository: repo, relayControlToken: controlToken }));
    expect((await terminal(proof)).status).toBe(200); expect((await row()).terminal_outcome).toBe(first.terminal_outcome);
    expect((await terminal({ ...proof, executionId: "other-run" })).status).toBe(409);
    const next = await authorize("immediately-after-reload");
    expect(next.authorized).toBe(true);
    await repo.finalizeReservation({ reservationId: first.reservation_id, tokenId: first.token_id, mode: "exact", actualCostMicrousd: 10 });
    const exact = await row(); expect((await terminal(proof)).status).toBe(200);
    expect(await row()).toEqual(exact);
  });

  it("fences old start and authorize replay even when the liability cap prevents execution release", async () => {
    const auth = await authorize("cap-fenced", 20_000_001);
    const start = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: "cap-attempt" };
    await repo.startReservation(start);
    clock = new Date(Date.parse(initialTime) + 30_000);
    const proof = await receipt();
    expect((await terminal({ ...proof, executionId: "wrong-attempt" })).status).toBe(409);
    const before = await finance();
    expect((await terminal(proof)).status).toBe(200);
    expect((await row()).execution_admission_release).toBeNull();
    await expect(repo.startReservation(start)).rejects.toMatchObject({ code: "reservation_closed" });
    await expect(authorize("cap-fenced", 20_000_001)).rejects.toMatchObject({ code: "reservation_closed" });
    expect(await finance()).toEqual(before);
  });

  it("preserves slot_busy when a terminal receipt commits while authorization waits to enter its transaction", async () => {
    const auth = await authorize("cap-waiting-a", 20_000_001);
    await repo.startReservation({ reservationId: auth.reservation.reservationId,
      tokenId: credential.tokenId, executionId: "cap-waiting-attempt" });
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const waitingDb: PlatformDB = { ...db, async transaction(work) {
      entered.resolve(); await resume.promise; return db.transaction(work);
    } };
    const waitingRepo = createAiFundedPolicyRepository({ db: waitingDb, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), credentialTtlMs: 3_600_000, inFlightTtlMs: 30 * 60_000 });
    clock = new Date(Date.parse(initialTime) + 29_000);
    const admission = Promise.allSettled([waitingRepo.authorize({ credential: credential.token,
      requestId: "cap-waiting-b", modelId, billingMode: "usage", maxCostMicrousd: 100 })]);
    await entered.promise;
    let saved: Awaited<ReturnType<typeof row>>;
    const before = await finance();
    try {
      clock = new Date(Date.parse(initialTime) + 30_000);
      expect((await terminal(await receipt())).status).toBe(200);
      saved = await row();
      expect(saved.execution_admission_release).toBeNull();
    } finally { resume.resolve(); }
    expect((await admission)[0]).toMatchObject({ status: "rejected",
      reason: { code: "rate_limited", reason: "slot_busy" } });
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().execute()).toEqual([saved!]);
    // The ordinary capacity claim commits the existing authorization snapshot's
    // timestamp; all amounts, holds and financial records stay unchanged.
    expect(await finance()).toEqual({ ...before, balances: before.balances.map(balance => ({
      ...balance, updated_at: "2026-09-10T12:00:29.000Z",
    })) });
  });

  it("keeps legacy start response bytes and never rebinds or downgrades a persisted attempt", async () => {
    const auth = await authorize("attempt-binding");
    const key = { reservationId: auth.reservation.reservationId, tokenId: credential.tokenId };
    const start = await repo.startReservation({ ...key, executionId: "attempt-one" });
    expect(start.executionId).toBe("attempt-one");
    expect(await repo.startReservation({ ...key, executionId: "attempt-one" })).toEqual(start);
    await expect(repo.startReservation(key)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repo.startReservation({ ...key, executionId: "attempt-two" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 0 });
    const legacy = await authorize("legacy-start");
    const old = await repo.startReservation({ reservationId: legacy.reservation.reservationId, tokenId: credential.tokenId });
    expect(old).not.toHaveProperty("executionId");
    expect(await repo.startReservation({ reservationId: legacy.reservation.reservationId, tokenId: credential.tokenId })).toEqual(old);
  });

  it("retains proof behind unrelated live speech and reconciles after public exact speech completion", async () => {
    const auth = await authorize("waiting-for-live-speech");
    const start = await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: "waiting-attempt" });
    const funding = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32),
      now: () => new Date(clock), reservationIdFactory: () => "other-live-speech" });
    const operations = createSpeechOperationsRepository({ db, now: () => new Date(clock) });
    const operationId = `sp_${clock.getTime()}_abcdefghijklmnop`;
    await operations.admit({ identity, requestId: operationId, sourceKind: "dictation", contentFingerprint: "a".repeat(64),
      policyRevision: "speech-v1", adapterId: "fixture", modelId: "speech-model", audioDurationMs: 1_000, maximumCostMicrousd: 100 },
      trx => funding.reserve(trx, { identity, requestId: operationId, policyRevision: "speech-v1", modelId: "speech-model", maximumCostMicrousd: 100 }));
    await operations.claimDispatch(identity, operationId, (trx, id) => funding.start(trx, id));
    clock = new Date(clock.getTime() + 30_000);
    const proof = { contractVersion: 1, ...identity, reservationId: start.reservationId, tokenId: start.tokenId, requestId: start.requestId,
      startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: start.executionId!, terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" };
    const readA = () => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", start.reservationId).executeTakeFirstOrThrow();
    const before = await finance();
    expect((await terminal(proof)).status).toBe(200);
    expect((await readA()).execution_admission_release).toBeNull(); expect(await finance()).toEqual(before);
    await expect(repo.startReservation({ reservationId: start.reservationId, tokenId: start.tokenId, executionId: start.executionId }))
      .rejects.toMatchObject({ code: "reservation_closed" });
    await operations.complete(identity, operationId, { executionState: "succeeded", outcomeCode: "transcript", actualCostMicrousd: 10 },
      (trx, id, actual) => funding.settle(trx, id, { mode: "exact", actualCostMicrousd: actual }));
    expect((await readA()).execution_admission_release).not.toBeNull();
    await expect(authorize("after-live-speech-ended")).resolves.toMatchObject({ authorized: true });
  });

  it.each(["released-before-receipt", "received-before-terminal", "different-start-attempt"])("rejects forged strong chronology/binding: %s", async (forgery) => {
    const auth = await authorize("audit-time");
    await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: "audit-attempt" });
    clock = new Date(clock.getTime() + 30_000); expect((await terminal(await receipt())).status).toBe(200);
    const saved = await row(); const audit = JSON.parse(saved.execution_admission_release!); const terminalAudit = JSON.parse(saved.terminal_outcome!);
    const start = JSON.parse(saved.start_response!);
    if (forgery === "released-before-receipt") audit.response.releasedAt = new Date(clock.getTime() - 1).toISOString();
    if (forgery === "received-before-terminal") terminalAudit.response.receivedAt = new Date(clock.getTime() - 1).toISOString();
    if (forgery === "different-start-attempt") start.executionId = "other-attempt";
    await db.executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: JSON.stringify(audit),
      terminal_outcome: JSON.stringify(terminalAudit), start_response: JSON.stringify(start) }).execute();
    const before = await finance();
    await expect(authorize("after-forged-history")).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await finance()).toEqual(before);
  });

  it.each([false, true])("bounded terminal transport outage=%s preserves holds and never redispatches", async (outage) => {
    const cfg = relayConfig(); let calls = 0; let generations = 0;
    const platform = createFundedPlatformClient({ ...cfg, fetch: async (url, init) => {
      if (String(url).endsWith("/terminal") && (++calls === 1 || outage)) return new Response("unavailable", { status: 503 });
      return app.request(String(url), init);
    } });
    let held: Awaited<ReturnType<typeof finance>>;
    relay = createFundedRelay({ ...cfg, platformClient: platform, now: () => new Date(clock), requestIdFactory: () => "outage-request",
      fetch: async () => { generations++; held = await finance(); clock = new Date(clock.getTime() + 30_000); throw new Error("original dispatch ended"); } });
    const relayApp = new Hono(); relay.register(relayApp);
    const began = Date.now();
    const result = await relayApp.request("/v1/chat/completions", { method: "POST", headers: {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, max_tokens: 256, messages: [{ role: "user", content: "Fixture" }] }) });
    expect(result.status).toBe(502); expect(Date.now() - began).toBeLessThan(2_000);
    expect(generations).toBe(1); expect(calls).toBe(2); expect(await finance()).toEqual(held!);
    if (outage) {
      expect((await row()).terminal_outcome).toBeNull(); expect((await row()).execution_admission_release).toBeNull();
      await expect(authorize("outage-next")).rejects.toMatchObject({ code: "rate_limited" });
    } else {
      expect((await row()).execution_admission_release).not.toBeNull();
      await expect(authorize("retry-next")).resolves.toMatchObject({ authorized: true });
    }
  });
  it.each(["missing-proof", "minimum-age", "terminal-grace", "unexpired", "liability-cap", "machine-identity", "malformed-proof"])("keeps admission and every financial byte for automatic %s guard", async (guard) => {
    repo = makeRepo(guard === "unexpired" ? 30 * 60_000 : 60_000);
    app = new Hono().route("/internal/ai/funded", createAiFundedRelayRoutes({ repository: repo, relayControlToken: controlToken }));
    const auth = await authorize("guard-request", guard === "liability-cap" ? 20_000_001 : 100);
    await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
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

  it("bounds unknown provider liability at twenty dollars and validates every retained audit", async () => {
    for (let index = 0; index < 3; index++) {
      const auth = await authorize(`unknown-${index}`, [12_000_000, 8_000_000, 100][index]);
      const start = await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: `execution-${index}` });
      clock = new Date(clock.getTime() + 30_000);
      expect((await terminal({ contractVersion: 1, ...identity, reservationId: start.reservationId, requestId: start.requestId,
        tokenId: start.tokenId, startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: `execution-${index}`,
        terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" })).status).toBe(200);
    }
    const before = await finance();
    await expect(authorize("fourth-unknown")).rejects.toMatchObject({ code: "rate_limited" });
    const saved = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("created_at").execute();
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

  it.each([false, true])("exact settlement reconciles pending terminal release after commit; unrelated corrupt audit=%s", async (corrupt) => {
    const saved = [];
    for (let index = 0; index < 3; index++) {
      const auth = await authorize(`pending-${index}`, [12_000_000, 8_000_000, 100][index]);
      const start = await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId, executionId: `pending-attempt-${index}` });
      clock = new Date(clock.getTime() + 30_000);
      const proof = { contractVersion: 1, ...identity, reservationId: start.reservationId, requestId: start.requestId,
        tokenId: start.tokenId, startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: start.executionId!,
        terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" };
      expect((await terminal(proof)).status).toBe(200);
      saved.push({ start, proof });
    }
    const get = (id: string) => db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", id).executeTakeFirstOrThrow();
    expect((await get(saved[2].start.reservationId)).execution_admission_release).toBeNull();
    if (corrupt) await db.executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: "{}" })
      .where("reservation_id", "=", saved[1].start.reservationId).execute();
    const settlement = { reservationId: saved[0].start.reservationId, tokenId: credential.tokenId, mode: "exact" as const, actualCostMicrousd: 10 };
    const result = await repo.finalizeReservation(settlement);
    expect(result.actualCostMicrousd).toBe(10);
    expect((await get(saved[0].start.reservationId)).status).toBe("settled");
    if (corrupt) {
      expect((await get(saved[2].start.reservationId)).execution_admission_release).toBeNull();
      return;
    }
    expect((await get(saved[2].start.reservationId)).execution_admission_release).not.toBeNull();
    const next = await authorize("after-event-recovery");
    await repo.startReservation({ reservationId: next.reservation.reservationId, tokenId: credential.tokenId, executionId: "next-attempt" });
    const activeBefore = await get(next.reservation.reservationId);
    const financeBeforeReplay = await finance();
    expect(await repo.finalizeReservation(settlement)).toEqual(result);
    expect((await terminal(saved[0].proof)).status).toBe(200);
    await expect(repo.releaseReservation({ reservationId: saved[0].start.reservationId, tokenId: credential.tokenId, reason: "pre_upstream_failure" }))
      .rejects.toMatchObject({ code: "reservation_closed" });
    expect(await get(next.reservation.reservationId)).toEqual(activeBefore);
    expect(await finance()).toEqual(financeBeforeReplay);
  });

  it("persists valid new terminal proof when an unrelated old audit prevents safe release", async () => {
    const first = await authorize("receipt-first");
    const a = await repo.startReservation({ reservationId: first.reservation.reservationId, tokenId: credential.tokenId, executionId: "receipt-attempt-a" });
    clock = new Date(clock.getTime() + 30_000);
    const proofA = { contractVersion: 1, ...identity, reservationId: a.reservationId, tokenId: a.tokenId, requestId: a.requestId,
      startedAt: a.startedAt, expiresAt: a.expiresAt, executionId: a.executionId!, terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" };
    expect((await terminal(proofA)).status).toBe(200);
    const second = await authorize("receipt-second");
    const b = await repo.startReservation({ reservationId: second.reservation.reservationId, tokenId: credential.tokenId, executionId: "receipt-attempt-b" });
    await db.executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: "{}" }).where("reservation_id", "=", a.reservationId).execute();
    const before = await finance();
    const proofB = { ...proofA, reservationId: b.reservationId, requestId: b.requestId, startedAt: b.startedAt,
      expiresAt: b.expiresAt, executionId: b.executionId! };
    expect((await terminal(proofB)).status).toBe(200);
    const saved = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", b.reservationId).executeTakeFirstOrThrow();
    expect(JSON.parse(saved.terminal_outcome!)).toMatchObject({ request: proofB });
    expect(saved.execution_admission_release).toBeNull(); expect(await finance()).toEqual(before);
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
