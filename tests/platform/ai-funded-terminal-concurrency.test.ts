import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";
import { createAiFundedSpeechFundingPort } from "../../packages/platform/src/speech/funding.js";
import { createPlatformDb, insertUserMachine, type PlatformDB, type PlatformDatabase } from "../../packages/platform/src/db.js";

// Explicitly opt in with a disposable loopback database; never accept a remote URL.
const url = process.env.MATRIX_TEST_POSTGRES_URL;
const identity = { ownerId: "race_owner", machineId: "race_machine", runtimeSlot: "primary" };
const modelId = "@cf/zai-org/glm-5.3-flash";
describe.skipIf(!url)("funded terminal owner lock with independent PostgreSQL pools", () => {
  const schema = `funded_terminal_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool; let a: PlatformDB; let b: PlatformDB; let clock: Date;
  let repoA: ReturnType<typeof createAiFundedPolicyRepository>; let repoB: typeof repoA;
  let credential: { token: string; tokenId: string }; let speech: ReturnType<typeof createAiFundedSpeechFundingPort>;
  let sequence = 0;
  const repo = (db: PlatformDB) => createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
    credentialTtlMs: 3_600_000, inFlightTtlMs: 60_000 });
  const authorize = (r: typeof repoA, requestId: string, maximum = 100) => r.authorize({ credential: credential.token, requestId, modelId, billingMode: "usage", maxCostMicrousd: maximum });
  const rows = () => a.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute();
  const financial = async () => ({ balances: await a.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await a.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    allocations: await a.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute() });
  const batch = async () => ({ expectedOwnerId: identity.ownerId, reviewer: "operator:race", evidenceRef: "fixture:race", acceptUnknownUpstreamLiability: true as const,
    reservations: (await rows()).map((r) => ({ ...identity, fundingKind: r.token_id.startsWith("speech_") ? "speech" as const : "usage" as const,
      reservationId: r.reservation_id, tokenId: r.token_id, expectedRequestId: r.request_id, expectedStartedAt: r.started_at!, expectedExpiresAt: r.expires_at,
      maximumLiabilityMicrousd: 100, authorizationSha256: createHash("sha256").update(r.authorization_response).digest("hex"),
      localRunId: `run-${r.request_id}`, localRunState: "failed" as const, localRunEndedAt: r.expires_at })) });
  const reserveSpeech = (db: PlatformDB, requestId: string) => db.transaction((trx) => speech.reserve(trx.executor as Transaction<PlatformDatabase>, {
    identity, requestId, policyRevision: "speech-v1", modelId: "speech-model", maximumCostMicrousd: 100 }));
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["127.0.0.1", "[::1]"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test")) throw new Error("Disposable literal-loopback _test database required");
    admin = new pg.Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(url!); scoped.searchParams.set("options", `-c search_path=${schema} -c lock_timeout=3000 -c statement_timeout=5000`);
    scoped.searchParams.set("application_name", "funded-terminal-race-a"); a = createPlatformDb(scoped.toString()); await a.ready;
    scoped.searchParams.set("application_name", "funded-terminal-race-b"); b = createPlatformDb(scoped.toString()); await b.ready;
  });
  beforeEach(async () => {
    await a.executor.deleteFrom("user_machines").execute(); sequence = 0; clock = new Date("2026-09-10T12:00:00.000Z"); repoA = repo(a); repoB = repo(b);
    await insertUserMachine(a, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: "race", runtimeSlot: identity.runtimeSlot,
      status: "running", imageVersion: "test", provisionedAt: clock.toISOString(), activationState: "authorized" });
    const policy = await repoA.getGlobalPolicy(); await repoA.updateGlobalPolicy({ expectedRevision: policy.revision, enabled: true, allowedModelIds: [modelId] });
    await repoA.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 40_000_000, expiresAt: null });
    await repoA.grantCredit({ entryId: "race-credit", identity, kind: "addon_grant", amountMicrousd: 40_000_000, sourceReference: "fixture" });
    credential = (await repoA.issueRuntimeCredential(identity)).credential;
    const old = await authorize(repoA, "old-glm"); await repoA.startReservation({ reservationId: old.reservation.reservationId, tokenId: credential.tokenId });
    speech = createAiFundedSpeechFundingPort({ allowedSources: ["addon"], credentialHashSecret: "s".repeat(32), now: () => new Date(clock),
      reservationIdFactory: () => `speech-race-${++sequence}`, inFlightTtlMs: 60_000 });
  });
  afterAll(async () => { await b?.destroy(); await a?.destroy(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  async function oldMixed() {
    const r = await reserveSpeech(a, "old-speech"); await a.transaction((trx) => speech.start(trx.executor as Transaction<PlatformDatabase>, r.reservationId));
    clock = new Date(clock.getTime() + 20 * 60_000); return batch();
  }
  async function strongStart(requestId: string, maximum = 100) {
    const initial = (await rows()).find(row => row.request_id === "old-glm")!;
    if (initial.status === "in_flight") await repoA.finalizeReservation({ reservationId: initial.reservation_id,
      tokenId: initial.token_id, mode: "exact", actualCostMicrousd: 0 });
    const authorized = await authorize(repoA, requestId, maximum);
    return repoA.startReservation({ reservationId: authorized.reservation.reservationId,
      tokenId: credential.tokenId, executionId: `attempt-${requestId}` });
  }
  function proof(start: Awaited<ReturnType<typeof strongStart>>) {
    return { contractVersion: 1 as const, ...identity, reservationId: start.reservationId, tokenId: start.tokenId,
      requestId: start.requestId, startedAt: start.startedAt, expiresAt: start.expiresAt, executionId: start.executionId!,
      terminalState: "failed" as const, terminalAt: clock.toISOString(), outcome: "usage_unknown" as const };
  }
  async function waitForPoolBLock() {
    let waiting = false; const deadline = Date.now() + 2_000;
    while (!waiting && Date.now() < deadline) {
      waiting = Boolean((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='funded-terminal-race-b' AND wait_event_type='Lock') AS waiting")).rows[0].waiting);
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
  }
  it("refreshes receipt/release chronology after owner-lock wait and serializes immediate admission", async () => {
    const started = await strongStart("immediate-a");
    clock = new Date(clock.getTime() + 30_000); const terminal = proof(started);
    terminal.terminalAt = new Date(clock.getTime() + 15_000).toISOString();
    const locked = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const blocker = a.transaction(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const receipt = repoB.recordTerminalOutcome(terminal);
    const received = Promise.allSettled([receipt]);
    await waitForPoolBLock();
    clock = new Date(clock.getTime() + 30_000); release.resolve(); await blocker;
    expect((await received)[0]).toMatchObject({ status: "fulfilled", value: { receivedAt: clock.toISOString() } });
    const saved = (await rows()).find(row => row.reservation_id === started.reservationId)!;
    expect(JSON.parse(saved.execution_admission_release!).response.releasedAt).toBe(clock.toISOString());
    const admissions = await Promise.allSettled([authorize(repoA, "immediate-b"), authorize(repoB, "competing-b")]);
    expect(admissions.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const admitted = admissions.find(result => result.status === "fulfilled")!;
    if (admitted.status !== "fulfilled") throw new Error("Admission missing");
    const bStart = { reservationId: admitted.value.reservation.reservationId, tokenId: credential.tokenId, executionId: "attempt-b" };
    const races = await Promise.allSettled([
      repoA.startReservation({ reservationId: started.reservationId, tokenId: started.tokenId, executionId: started.executionId }),
      repoB.startReservation(bStart), repoA.finalizeReservation({ reservationId: started.reservationId, tokenId: started.tokenId, mode: "exact", actualCostMicrousd: 10 }),
      repoB.recordTerminalOutcome(terminal),
    ]);
    expect(races[0]).toMatchObject({ status: "rejected", reason: { code: "reservation_closed" } });
    expect(races.slice(1).every(result => result.status === "fulfilled")).toBe(true);
    expect((await rows()).find(row => row.reservation_id === bStart.reservationId)).toMatchObject({ status: "in_flight", execution_admission_release: null, actual_microusd: null });
  });
  it("takes machine lock before the terminal reservation lock while policy mutation waits", async () => {
    const started = await strongStart("machine-order"); clock = new Date(clock.getTime() + 30_000);
    const locked = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const policy = a.transaction(async trx => {
      await trx.executor.selectFrom("user_machines").select("machine_id").where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
      await trx.executor.updateTable("ai_funded_runtime_policies").set({ enabled: false }).where("machine_id", "=", identity.machineId).execute();
    });
    await locked.promise;
    const terminal = repoB.recordTerminalOutcome(proof(started));
    const results = Promise.allSettled([policy, terminal]);
    try {
      await waitForPoolBLock();
      await admin.query("BEGIN");
      try { await admin.query(`SELECT reservation_id FROM "${schema}".ai_funded_usage_reservations WHERE reservation_id=$1 FOR UPDATE NOWAIT`, [started.reservationId]); }
      finally { await admin.query("ROLLBACK"); }
    } finally { release.resolve(); }
    expect((await results).every(result => result.status === "fulfilled")).toBe(true);
  });
  it("serializes cap-blocked receipt replay, exact settlement and future admission across pools", async () => {
    const attempts = [];
    for (let index = 0; index < 3; index++) {
      const start = await strongStart(`cap-${index}`, [12_000_000, 8_000_000, 100][index]); clock = new Date(clock.getTime() + 30_000);
      const terminal = proof(start); await repoA.recordTerminalOutcome(terminal); attempts.push({ start, terminal });
    }
    const pending = attempts[2];
    expect((await rows()).find(row => row.reservation_id === pending.start.reservationId)!.execution_admission_release).toBeNull();
    const settlement = { reservationId: attempts[0].start.reservationId, tokenId: credential.tokenId, mode: "exact" as const, actualCostMicrousd: 10 };
    const outcomes = await Promise.allSettled([repoA.finalizeReservation(settlement), repoB.recordTerminalOutcome(pending.terminal), authorize(repoB, "cap-future")]);
    expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1].status).toBe("fulfilled");
    const saved = await rows();
    expect(saved.find(row => row.reservation_id === pending.start.reservationId)!.execution_admission_release).not.toBeNull();
    const unknown = saved.filter(row => row.execution_admission_release !== null && row.actual_microusd === null);
    expect(unknown.map(row => row.execution_recovery_slot).sort()).toEqual([0, 1]);
    expect(await repoA.finalizeReservation(settlement)).toMatchObject({ actualCostMicrousd: 10 });
    const next = await authorize(repoB, "cap-future"); expect(next.authorized).toBe(true);
  });
  it("serializes two automatic admissions into one new dispatch slot", async () => {
    const old = (await rows())[0]; clock = new Date(clock.getTime() + 30_000);
    await repoA.recordTerminalOutcome({ contractVersion: 1, ...identity, reservationId: old.reservation_id, tokenId: old.token_id, requestId: old.request_id,
      startedAt: old.started_at!, expiresAt: old.expires_at, executionId: "relay-race", terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    clock = new Date(clock.getTime() + 17 * 60_000);
    const result = await Promise.allSettled([authorize(repoA, "next-a"), authorize(repoB, "next-b")]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await rows()).filter((r) => r.execution_admission_release !== null)).toHaveLength(1);
    expect((await rows()).filter((r) => r.execution_admission_release === null && r.status === "reserved")).toHaveLength(1);
    expect(Number((await financial()).balances[0].reserved_microusd)).toBe(200);
  });
  it("concurrent identical mixed batches return one immutable result without money changes", async () => {
    const request = await oldMixed(); const before = await financial();
    const result = await Promise.all([repoA.releaseExecutionAdmissionBatch(request), repoB.releaseExecutionAdmissionBatch(request)]);
    expect(result[0]).toEqual(result[1]); expect(await financial()).toEqual(before);
    expect((await rows()).map((r) => r.execution_recovery_slot).sort()).toEqual([0, 1]);
  });
  it("serializes new speech funding against atomic mixed recovery with no partial result", async () => {
    const request = await oldMixed(); const result = await Promise.allSettled([repoA.releaseExecutionAdmissionBatch(request), reserveSpeech(b, "new-speech")]);
    expect(result[1].status).toBe("fulfilled");
    const released = (await rows()).filter((r) => r.execution_admission_release !== null);
    expect(released).toHaveLength(result[0].status === "fulfilled" ? 2 : 0);
    expect(Number((await financial()).balances[0].reserved_microusd)).toBe(300);
  });
  it("speech start waits for the same owner lock before taking its reservation lock", async () => {
    const r = await reserveSpeech(a, "waiting-speech"); const locked = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const blocker = a.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor); locked.resolve(); await release.promise;
    });
    await locked.promise;
    const started = b.transaction((trx) => speech.start(trx.executor as Transaction<PlatformDatabase>, r.reservationId));
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='funded-terminal-race-b' AND wait_event_type='Lock') AS waiting")).rows[0].waiting);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await rows()).find((row) => row.reservation_id === r.reservationId)!.status).toBe("reserved");
    } finally { release.resolve(); await blocker; }
    await started;
    expect((await rows()).find((row) => row.reservation_id === r.reservationId)!.status).toBe("in_flight");
  });
  it.each(["complete", "cancel"] as const)("speech %s waits for owner before locking operation rows", async (action) => {
    const opsA = createSpeechOperationsRepository({ db: a, now: () => new Date(clock) });
    const opsB = createSpeechOperationsRepository({ db: b, now: () => new Date(clock) });
    const requestId = `sp_${clock.getTime()}_abcdefghijklmnop`;
    await opsA.admit({ identity, requestId, sourceKind: "dictation", contentFingerprint: "a".repeat(64),
      policyRevision: "speech-v1", adapterId: "fixture", modelId: "speech-model", audioDurationMs: 1_000, maximumCostMicrousd: 100 },
      (trx) => speech.reserve(trx, { identity, requestId, policyRevision: "speech-v1", modelId: "speech-model", maximumCostMicrousd: 100 }));
    if (action === "complete") await opsA.claimDispatch(identity, requestId, (trx, id) => speech.start(trx, id));
    const locked = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const blocker = a.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor); locked.resolve(); await release.promise;
    });
    await locked.promise;
    const mutation = action === "complete"
      ? opsB.complete(identity, requestId, { executionState: "succeeded", outcomeCode: "transcript", actualCostMicrousd: 10 }, (trx, id, actual) => speech.settle(trx, id, { mode: "exact", actualCostMicrousd: actual }))
      : opsB.cancel(identity, requestId, (trx, id) => speech.release(trx, id));
    let rowUnlocked = true;
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='funded-terminal-race-b' AND wait_event_type='Lock') AS waiting")).rows[0].waiting);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await admin.query("BEGIN");
      try { await admin.query(`SELECT operation_id FROM "${schema}".speech_operations WHERE operation_id=$1 FOR UPDATE NOWAIT`, [requestId]); }
      catch (error) { if ((error as { code?: string }).code === "55P03") rowUnlocked = false; else throw error; }
      finally { await admin.query("ROLLBACK"); }
    } finally { release.resolve(); await blocker; await mutation; }
    expect(rowUnlocked).toBe(true);
    // Replaying a dispatch claim races against completed/cancelled state without redispatch.
    const outcomes = await Promise.all([opsA.claimDispatch(identity, requestId), opsB.claimDispatch(identity, requestId)]);
    expect(outcomes.every((r) => !r.claimed)).toBe(true);
  });

  it("takes automatic recovery machine locks before runtime policy rows", async () => {
    const old = (await rows())[0]; clock = new Date(clock.getTime() + 30_000);
    await repoA.recordTerminalOutcome({ contractVersion: 1, ...identity, reservationId: old.reservation_id, tokenId: old.token_id, requestId: old.request_id,
      startedAt: old.started_at!, expiresAt: old.expires_at, executionId: "relay-policy-race", terminalState: "failed", terminalAt: clock.toISOString(), outcome: "usage_unknown" });
    clock = new Date(clock.getTime() + 17 * 60_000);
    const locked = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const policyUpdate = a.transaction(async (trx) => {
      await trx.executor.selectFrom("user_machines").select("machine_id").where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      locked.resolve(); await release.promise;
      await trx.executor.updateTable("ai_funded_runtime_policies").set({ enabled: false }).where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();
    });
    await locked.promise;
    const admission = authorize(repoB, "policy-race-new");
    // Attach immediately so a real PostgreSQL deadlock error cannot become an unhandled rejection.
    const result = Promise.allSettled([policyUpdate, admission]);
    try {
      let waiting = false; const deadline = Date.now() + 2_000;
      while (!waiting && Date.now() < deadline) {
        waiting = Boolean((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='funded-terminal-race-b' AND wait_event_type='Lock') AS waiting")).rows[0].waiting);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { release.resolve(); }
    const outcomes = await result; expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "access_disabled" } });
    expect((await rows())[0].execution_admission_release).toBeNull();
  });

});
