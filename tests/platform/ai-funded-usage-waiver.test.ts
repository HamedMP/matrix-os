import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createExpiredUsageWaiver } from "../../packages/platform/src/ai-funded-usage-waiver.js";
import { createPlatformDb, insertUserMachine, type PlatformDB, type PlatformDatabase } from "../../packages/platform/src/db.js";
import { migrateAiFunded } from "../../packages/platform/src/database/migrations/ai-funded.js";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { migratePlatformSchema } from "../../packages/platform/src/database/migrate.js";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";
import { sql } from "kysely";
import { migratePreviewDrive as migrateGenerationSeventeenPreviewDrive } from "./fixtures/platform-generation-seventeen-preview-drive.js";
import { eraseOwnerPlatformData } from "../../packages/platform/src/account-deletion/cleanup-data.js";
import { createFundedHostConfigRoutes } from "../../packages/platform/src/funded-host-config.js";
import { buildPlatformSyncVerificationToken } from "../../packages/platform/src/platform-token.js";
import { Hono } from "hono";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const identity = { ownerId: "waiver_owner", machineId: "12345678-1234-4234-8234-123456789abc", runtimeSlot: "primary" as const };
const modelId = "anthropic/claude-sonnet-5";
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;

for (const postgres of [false, true]) describe.skipIf(postgres && !databaseUrl)(
  `expired usage waiver (${postgres ? "independent PostgreSQL pools" : "PGlite"})`, () => {
    let db: PlatformDB;
    let other: PlatformDB;
    let admin: pg.Pool | undefined;
    let schema: string;
    let connectionString: string;
    let clock: Date;
    let repo: ReturnType<typeof createAiFundedPolicyRepository>;
    let credential: { token: string; tokenId: string };
    let input: Parameters<ReturnType<typeof createExpiredUsageWaiver>>[0];
    const waiver = (target = db) => createExpiredUsageWaiver({ db: target, now: () => new Date(clock) });
    const snapshot = async () => ({
      rows: await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().orderBy("reservation_id").execute(),
      balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
      ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    });
    async function recover(index = 0) {
      const item = input.reservations[index];
      await repo.releaseExecutionAdmission(identity, { reservationId: item.reservationId, tokenId: item.tokenId,
        expectedOwnerId: identity.ownerId, expectedRequestId: item.requestId, expectedStartedAt: item.startedAt,
        expectedExpiresAt: item.expiresAt, maximumLiabilityMicrousd: item.maximumLiabilityMicrousd,
        localRunId: `local-${item.requestId}`, localRunState: "failed", localRunEndedAt: item.expiresAt,
        evidenceRef: "support:ended", reviewer: "operator:test", acceptUnknownUpstreamLiability: true });
      const row = await db.executor.selectFrom("ai_funded_usage_reservations").select("execution_admission_release")
        .where("reservation_id", "=", item.reservationId).executeTakeFirstOrThrow();
      item.executionAdmissionReleaseSha256 = createHash("sha256").update(row.execution_admission_release!).digest("hex");
    }
    async function appendRequest(id: string) {
      const auth = await repo.authorize({ credential: credential.token, requestId: id, modelId,
        maxCostMicrousd: 100, billingMode: "usage" });
      await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
      const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", auth.reservation.reservationId).executeTakeFirstOrThrow();
      input.reservations.push({ reservationId: row.reservation_id, tokenId: row.token_id, requestId: row.request_id,
        startedAt: row.started_at!, expiresAt: row.expires_at, reservedMicrousd: 100,
        promotionalReservedMicrousd: 0, addonReservedMicrousd: 100, maximumLiabilityMicrousd: 100,
        authorizationSha256: createHash("sha256").update(row.authorization_response).digest("hex"),
        fundingAllocationSha256: createHash("sha256").update("[]").digest("hex"), executionAdmissionReleaseSha256: null });
      input.expectedReleasedMicrousd += 100; input.expectedMaximumLiabilityMicrousd += 100;
      clock = new Date(clock.getTime() + 20 * 60_000);
    }
    beforeEach(async () => {
      vi.stubEnv("ACCOUNT_DELETION_SECRET", undefined);
      vi.stubEnv("ACCOUNT_DELETION_ENABLED", undefined);
      if (postgres) {
        schema = `waiver_${randomUUID().replaceAll("-", "")}`;
        admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        await admin.query(`CREATE SCHEMA "${schema}"`);
        const url = new URL(databaseUrl!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        connectionString = url.toString();
        db = createPlatformDb(url.toString());
        await db.ready;
        other = createPlatformDb(url.toString());
        await other.ready;
      } else { ({ db } = await createTestPlatformDb()); other = db; }
      clock = new Date("2026-09-10T12:00:00.000Z");
      repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32), now: () => new Date(clock),
        credentialTtlMs: 3_600_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
      await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
        handle: "waiver-machine", runtimeSlot: "primary", status: "running", imageVersion: "test",
        provisionedAt: clock.toISOString(), activationState: "authorized" });
      await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
      await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
        allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
      await repo.grantCredit({ entryId: "waiver-grant", identity, kind: "promotional_grant",
        amountMicrousd: 1_000, sourceReference: "fixture", expiresAt: "2026-09-11T00:00:00.000Z" });
      credential = (await repo.issueRuntimeCredential(identity)).credential;
      const auth = await repo.authorize({ credential: credential.token, requestId: "old-request", modelId,
        maxCostMicrousd: 2_000, billingMode: "usage" });
      await repo.startReservation({ reservationId: auth.reservation.reservationId, tokenId: credential.tokenId });
      const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().executeTakeFirstOrThrow();
      input = { identity: { ...identity }, expectedRuntimeTokenEpoch: 1, accountDeletionMode: "disabled", reviewer: "operator:test", evidenceRef: "support:waiver", reason: "expired_unknown_usage",
        acceptPlatformLiability: true, expectedReleasedMicrousd: 1_000, expectedMaximumLiabilityMicrousd: 2_000,
        reservations: [{ reservationId: row.reservation_id, tokenId: row.token_id, requestId: row.request_id,
          startedAt: row.started_at!, expiresAt: row.expires_at, reservedMicrousd: 1_000,
          promotionalReservedMicrousd: 1_000, addonReservedMicrousd: 0, maximumLiabilityMicrousd: 2_000,
          authorizationSha256: createHash("sha256").update(row.authorization_response).digest("hex"),
          fundingAllocationSha256: createHash("sha256").update(JSON.stringify([{ grantEntryId: "waiver-grant", amountMicrousd: 1_000 }])).digest("hex"),
          executionAdmissionReleaseSha256: null }] };
      clock = new Date(clock.getTime() + 20 * 60_000);
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      if (other && other !== db) await other.destroy();
      await destroyTestPlatformDb(db);
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); admin = undefined; }
    });

    it("dry runs without changing any financial or reservation bytes", async () => {
      const before = await snapshot();
      expect(await waiver()(input)).toMatchObject({ mode: "dry-run", releasedMicrousd: 1_000,
        maximumLiabilityMicrousd: 2_000, usageKnown: false });
      expect(await snapshot()).toEqual(before);
    });
    it("waives once, keeps unknown actual, admits new work and fences the old replay", async () => {
      const response = await waiver()(input, { apply: true });
      expect(await waiver()(input, { apply: true })).toEqual(response);
      const row = (await snapshot()).rows[0];
      expect(row).toMatchObject({ status: "waived", actual_microusd: null, settled_at: null,
        settlement_response: null });
      expect(JSON.parse(row.charge_waiver!)).toMatchObject({ request: input,
        response: { releasedMicrousd: 1_000, maximumLiabilityMicrousd: 2_000 } });
      expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0,
        remainingBalanceMicrousd: 1_000, reservedThisMonthMicrousd: 0, settledThisMonthMicrousd: 0 });
      await expect(repo.startReservation({ reservationId: row.reservation_id, tokenId: row.token_id }))
        .rejects.toMatchObject({ code: "reservation_closed" });
      await expect(repo.authorize({ credential: credential.token, requestId: row.request_id, modelId,
        maxCostMicrousd: 2_000, billingMode: "usage" })).rejects.toMatchObject({ code: "reservation_closed" });
      await expect(repo.authorize({ credential: credential.token, requestId: "new-work", modelId,
        maxCostMicrousd: 100, billingMode: "usage" })).resolves.toMatchObject({ authorized: true });
    });
    it("late authentic usage records platform expense without touching new holds or owner money", async () => {
      await waiver()(input, { apply: true });
      await repo.authorize({ credential: credential.token, requestId: "new-work", modelId,
        maxCostMicrousd: 100, billingMode: "usage" });
      const before = await snapshot();
      const key = { reservationId: input.reservations[0].reservationId, tokenId: credential.tokenId };
      const settled = await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_800 });
      expect(settled).toMatchObject({ actualCostMicrousd: 1_800, chargedCostMicrousd: 0,
        matrixAbsorbedMicrousd: 1_800, releasedMicrousd: 0 });
      expect(await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_800 })).toEqual(settled);
      expect((await snapshot()).balances).toEqual(before.balances);
      expect((await snapshot()).ledger).toEqual(before.ledger);
      await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_799 }))
        .rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await waiver()(input, { apply: true })).toMatchObject({ releasedMicrousd: 1_000 });
    });
    it("never turns conservative or over-ceiling late receipts into actual expense", async () => {
      await waiver()(input, { apply: true });
      const key = { reservationId: input.reservations[0].reservationId, tokenId: credential.tokenId };
      await expect(repo.finalizeReservation({ ...key, mode: "conservative" })).rejects.toMatchObject({ code: "unavailable" });
      await expect(repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 2_001 }))
        .rejects.toMatchObject({ code: "over_settlement" });
      expect((await snapshot()).rows[0].actual_microusd).toBeNull();
    });
    it("expires backing promotions instead of resurrecting them, with month isolation", async () => {
      clock = new Date("2026-10-01T12:00:00.000Z");
      await db.executor.updateTable("ai_funded_runtime_balances").set({ month_period_start: "2026-10-01T00:00:00.000Z",
        month_reserved_microusd: 0, month_spent_microusd: 7 }).where("machine_id", "=", identity.machineId).execute();
      await waiver()(input, { apply: true });
      expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 0 });
      const balance = (await snapshot()).balances[0];
      expect(Number(balance.month_reserved_microusd)).toBe(0);
      expect(Number(balance.month_spent_microusd)).toBe(7);
    });
    it.each(["owner", "snapshot", "hold", "totals", "reviewer"])("rejects changed %s without any writes", async (field) => {
      if (field === "owner") input.identity.ownerId = "other_owner";
      if (field === "snapshot") input.reservations[0].authorizationSha256 = "0".repeat(64);
      if (field === "hold") input.reservations[0].reservedMicrousd = 999;
      if (field === "totals") input.expectedMaximumLiabilityMicrousd = 1_999;
      if (field === "reviewer") { await waiver()(input, { apply: true }); input.reviewer = "operator:other"; }
      const before = await snapshot();
      await expect(waiver()(input, { apply: true })).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
    it("rejects early expiry/grace and stale machine authorization", async () => {
      clock = new Date("2026-09-10T12:02:00.000Z");
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "rate_limited" });
      clock = new Date("2026-09-10T13:00:00.000Z");
      await db.executor.updateTable("user_machines").set({ activation_state: "cancelled" })
        .where("machine_id", "=", identity.machineId).execute();
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "identity_mismatch" });
    });
    it("refuses a partial batch and a concurrent duplicate cannot refund twice", async () => {
      const bad = structuredClone(input);
      bad.reservations.push({ ...bad.reservations[0], reservationId: "missing", requestId: "missing" });
      bad.expectedReleasedMicrousd *= 2; bad.expectedMaximumLiabilityMicrousd *= 2;
      const before = await snapshot();
      await expect(waiver()(bad, { apply: true })).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      // PGlite is one connection, not evidence of independent concurrent transactions.
      const outcomes = postgres ? await Promise.all([waiver()(input, { apply: true }), waiver(other)(input, { apply: true })])
        : [await waiver()(input, { apply: true }), await waiver()(input, { apply: true })];
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0, remainingBalanceMicrousd: 1_000 });
    });
    it("migration revalidates the immutable waiver and retains its null provider cost", async () => {
      await waiver()(input, { apply: true });
      await migrateAiFunded(db.executor);
      expect((await snapshot()).rows[0]).toMatchObject({ status: "waived", actual_microusd: null });
      await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: "{}" })
        .where("reservation_id", "=", input.reservations[0].reservationId).execute();
      await expect(migrateAiFunded(db.executor)).rejects.toThrow();
    });
    it("waives a complete three-record batch, retains old recovery audits and frees their slots", async () => {
      await db.executor.updateTable("ai_funded_runtime_policies").set({ monthly_budget_microusd: 5_000 }).execute();
      await repo.grantCredit({ entryId: "extra-addon", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "fixture" });
      await recover(); await appendRequest("second-old"); await recover(1); await appendRequest("third-old");
      const before = await snapshot();
      expect(await waiver()(input, { apply: true })).toMatchObject({ releasedMicrousd: 1_200, maximumLiabilityMicrousd: 2_200 });
      const after = await snapshot();
      expect(after.rows.every((row) => row.status === "waived" && row.actual_microusd === null)).toBe(true);
      expect(after.rows.map((row) => row.execution_admission_release)).toEqual(before.rows.map((row) => row.execution_admission_release));
      expect(after.ledger).toEqual(before.ledger);
      expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 0, remainingBalanceMicrousd: 2_000 });
      await migrateAiFunded(db.executor);
      // Existing two-slot recovery remains bounded but waived liabilities have a distinct inventory.
      credential = (await repo.issueRuntimeCredential(identity)).credential;
      await appendRequest("new-recovery");
      await recover(3);
    });
    it("defers other owner execution without any mutation", async () => {
      await db.executor.updateTable("ai_funded_runtime_policies").set({ monthly_budget_microusd: 5_000 }).execute();
      await repo.grantCredit({ entryId: "extra-addon", identity, kind: "addon_grant", amountMicrousd: 1_000, sourceReference: "fixture" });
      await recover();
      await repo.authorize({ credential: credential.token, requestId: "other-live", modelId, maxCostMicrousd: 100, billingMode: "usage" });
      const before = await snapshot();
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "rate_limited" });
      expect(await snapshot()).toEqual(before);
    });
    it("refuses changed promotional source allocation snapshots", async () => {
      input.reservations[0].fundingAllocationSha256 = "0".repeat(64);
      const before = await snapshot();
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it("requires a valid audit to remove the host-config barrier, with no read-driven financial writes", async () => {
      const secret = "test-host-config-platform-secret";
      const hostIdentity = { handle: "waiver-machine", machineId: identity.machineId, runtimeSlot: "primary" };
      const app = new Hono().route("/internal/containers/:handle", createFundedHostConfigRoutes({ db,
        platformSecret: secret, now: () => new Date(clock), config: { enabled: true,
          machineIds: [identity.machineId], validThrough: "2026-09-11T00:00:00.000Z", sourceSha: "a".repeat(40),
          relayOrigin: "https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app" } }));
      const request = () => app.request("/internal/containers/waiver-machine/funded-host-config", { headers: {
        authorization: `Bearer ${buildPlatformSyncVerificationToken(hostIdentity, secret, 1)}`,
        "x-matrix-machine-id": identity.machineId, "x-matrix-runtime-slot": "primary", "x-matrix-runtime-token-epoch": "1" } });
      expect((await request()).status).toBe(503);
      await waiver()(input, { apply: true });
      const before = await snapshot();
      expect((await request()).status).toBe(200);
      expect(await snapshot()).toEqual(before);
      await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: "{}" }).execute();
      expect((await request()).status).toBe(503);
    });
    it("cannot erase a waived request with unknown platform liability", async () => {
      await waiver()(input, { apply: true });
      const before = await snapshot();
      await expect(eraseOwnerPlatformData(db, identity.ownerId)).rejects.toThrow("accounting_reconciliation_required");
      expect(await snapshot()).toEqual(before);
    });
    it("fails closed on corrupt waived liability before admission or funding projection", async () => {
      await waiver()(input, { apply: true });
      await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: "{}" }).execute();
      const before = await snapshot();
      await expect(repo.authorize({ credential: credential.token, requestId: "corrupt-waiver-new-work", modelId,
        maxCostMicrousd: 100, billingMode: "usage" })).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(repo.getFundingSummary(identity)).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(repo.getCheckoutFundingSummary(identity, Date.now() + 5_000))
        .rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it.each(["missing", "mismatched", "settled-unknown"])("rejects %s waiver evidence at admission", async (kind) => {
      await waiver()(input, { apply: true });
      const row = (await snapshot()).rows[0];
      if (kind === "missing") {
        await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_charge_waiver_state_check`.execute(db.executor);
        await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: null }).execute();
      } else if (kind === "settled-unknown") {
        await db.executor.updateTable("ai_funded_usage_reservations").set({ status: "settled" }).execute();
      } else {
        const audit = JSON.parse(row.charge_waiver!);
        audit.request.identity.ownerId = "unrelated-owner";
        await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: JSON.stringify(audit) }).execute();
      }
      const before = await snapshot();
      await expect(repo.authorize({ credential: credential.token, requestId: "bad-audit-new", modelId,
        maxCostMicrousd: 100, billingMode: "usage" })).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it("requires the explicit deletion namespace mode and refuses unidentifiable active jobs", async () => {
      const before = await snapshot();
      input.accountDeletionMode = "configured";
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "unavailable" });
      vi.stubEnv("ACCOUNT_DELETION_SECRET", "local-waiver-configured-secret-32bytes");
      input.accountDeletionMode = "disabled";
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "unavailable" });
      input.accountDeletionMode = "configured";
      await expect(waiver()(input)).resolves.toMatchObject({ mode: "dry-run" });
      vi.stubEnv("ACCOUNT_DELETION_SECRET", undefined);
      input.accountDeletionMode = "disabled";
      await sql`INSERT INTO account_deletion_jobs(owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
        VALUES ('opaque-job','scheduled',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
      await expect(waiver()(input)).rejects.toMatchObject({ code: "access_disabled" });
      await expect(waiver()(input, { apply: true })).rejects.toMatchObject({ code: "access_disabled" });
      expect(await snapshot()).toEqual(before);
    });
    it("rejects corrupt waiver evidence before recovery of a different expired request", async () => {
      await waiver()(input, { apply: true });
      await appendRequest("later-recovery");
      await db.executor.updateTable("ai_funded_usage_reservations").set({ charge_waiver: "{}" })
        .where("reservation_id", "=", input.reservations[0].reservationId).execute();
      const before = await snapshot();
      await expect(recover(1)).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it("rejects an oversized but individually valid unknown-waiver inventory", async () => {
      await waiver()(input, { apply: true });
      const row = (await snapshot()).rows[0];
      for (let index = 1; index <= 10; index++) {
        const id = `inventory-${index}`;
        const capture = JSON.parse(row.authorization_response);
        capture.reservation.reservationId = id; capture.reservation.requestId = id;
        const authorization = JSON.stringify(capture);
        const audit = JSON.parse(row.charge_waiver!);
        audit.request.reservations[0].reservationId = id; audit.request.reservations[0].requestId = id;
        audit.request.reservations[0].authorizationSha256 = createHash("sha256").update(authorization).digest("hex");
        audit.response.fingerprint = createHash("sha256").update(JSON.stringify(audit.request)).digest("hex");
        await db.executor.insertInto("ai_funded_usage_reservations").values({ ...row,
          reservation_id: id, request_id: id, authorization_response: authorization,
          charge_waiver: JSON.stringify(audit) }).execute();
      }
      const before = await snapshot();
      await expect(repo.getFundingSummary(identity)).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await snapshot()).toEqual(before);
    });
    it.skipIf(!postgres).each(["insert", "state-change"])("rechecks a concurrent deletion %s before any financial write", async (kind) => {
      if (kind === "state-change") await sql`INSERT INTO account_deletion_jobs
        (owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
        VALUES ('concurrent-job','cancelled',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
      const before = await snapshot();
      let apply!: Promise<unknown>;
      await other.transaction(async (trx) => {
        await sql`LOCK TABLE account_deletion_jobs IN ROW EXCLUSIVE MODE`.execute(trx.executor);
        apply = waiver()(input, { apply: true });
        // Capture rejection promptly even if the lock holder commits before the waiver starts.
        void apply.catch(() => undefined);
        if (kind === "insert") await sql`INSERT INTO account_deletion_jobs
          (owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
          VALUES ('concurrent-job','scheduled',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(trx.executor);
        else await trx.executor.updateTable("account_deletion_jobs").set({ status: "scheduled" }).execute();
      });
      await expect(apply).rejects.toMatchObject({ code: "access_disabled" });
      expect(await snapshot()).toEqual(before);
    });
    it("anonymizes authentic platform expense only after late settlement, without keeping account locators", async () => {
      await waiver()(input, { apply: true });
      await repo.finalizeReservation({ reservationId: input.reservations[0].reservationId, tokenId: credential.tokenId,
        mode: "exact", actualCostMicrousd: 40 });
      await db.executor.updateTable("user_machines").set({ status: "deleted", deleted_at: clock.toISOString() }).execute();
      await sql`INSERT INTO account_deletion_jobs(owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
        VALUES ('waiver-opaque-deletion','processing',${clock.toISOString()},${clock.toISOString()},${clock.toISOString()},${clock.toISOString()})`.execute(db.executor);
      await eraseOwnerPlatformData(db, identity.ownerId, () => "waiver-opaque-deletion");
      const result = await db.executor.selectFrom("account_deletion_jobs").select("accounting_summary").executeTakeFirstOrThrow();
      expect(result.accounting_summary).toMatchObject({ waived_platform_expense: { entryCount: 1, amountMicrousd: 40 } });
      expect(JSON.stringify(result.accounting_summary)).not.toContain(identity.ownerId);
      expect((await snapshot()).rows).toEqual([]);
    });
    it("upgrades generation17 without destroying unrelated columns and older revisions skip", async () => {
      // Reconstruct only the undeployed waiver delta, retaining the exact predecessor's
      // status vocabulary and recovery index before running the real upgrade.
      await sql`ALTER TABLE ai_funded_usage_reservations DROP COLUMN charge_waiver CASCADE`.execute(db.executor);
      await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT ai_funded_usage_reservations_status_check`.execute(db.executor);
      await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_usage_reservations_status_check
        CHECK (status IN ('reserved','starting','in_flight','settling','releasing','settled','released','expired'))`.execute(db.executor);
      await sql`CREATE UNIQUE INDEX idx_ai_funded_unknown_admission_owner
        ON ai_funded_usage_reservations(owner_id, execution_recovery_slot)
        WHERE execution_admission_release IS NOT NULL AND actual_microusd IS NULL`.execute(db.executor);
      await migrateGenerationSeventeenPreviewDrive(db.executor);
      await sql`INSERT INTO preview_drive_grants(token_hash,kind,proof_nonce_hash,handle,actor_id,chat_id,
        turn_id,run_id,client_request_id,body_digest,expires_at,connection_id,provider_account_id)
        VALUES ('predecessor-grant','run','predecessor-proof','fixture','fixture','fixture','fixture','fixture',
          'fixture','fixture','2026-11-01','retained-connection','retained-account')`.execute(db.executor);
      const predecessorGrant = (await sql`SELECT * FROM preview_drive_grants`.execute(db.executor)).rows;
      const predecessorIndexes = (await sql`SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname=current_schema() AND tablename='preview_drive_grants' ORDER BY indexname`.execute(db.executor)).rows;
      await sql`ALTER TABLE user_machines ADD COLUMN preserved_predecessor_fixture TEXT DEFAULT 'retained'`.execute(db.executor);
      await sql`UPDATE platform_schema_revisions SET generation=17, fingerprint='9feab435402c8f98165baa5e66d1b4173d5cf9c7a205f525696a74eaf6a97b06' WHERE scope='core'`.execute(db.executor);
      const waiverShape = () => sql<{ waiver_column: boolean; waiver_index: boolean }>`
        SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='ai_funded_usage_reservations' AND column_name='charge_waiver') AS waiver_column,
          to_regclass('idx_ai_funded_unknown_waiver_owner') IS NOT NULL AS waiver_index
      `.execute(db.executor);
      expect((await waiverShape()).rows).toEqual([{ waiver_column: false, waiver_index: false }]);
      const predecessorRecoveryIndex = (await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes
        WHERE schemaname=current_schema() AND indexname='idx_ai_funded_unknown_admission_owner'`.execute(db.executor)).rows;
      expect(predecessorRecoveryIndex).toHaveLength(1);
      expect(predecessorRecoveryIndex[0].indexdef).toMatch(/WHERE .*execution_admission_release IS NOT NULL.*actual_microusd IS NULL/);
      expect(predecessorRecoveryIndex[0].indexdef).not.toContain('charge_waiver');
      await runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION });
      expect((await waiverShape()).rows).toEqual([{ waiver_column: true, waiver_index: true }]);
      expect((await sql`SELECT generation,fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db.executor)).rows)
        .toEqual([PLATFORM_SCHEMA_REVISION]);
      expect((await sql`SELECT * FROM preview_drive_grants`.execute(db.executor)).rows).toEqual(predecessorGrant);
      expect((await sql`SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname=current_schema() AND tablename='preview_drive_grants' ORDER BY indexname`.execute(db.executor)).rows).toEqual(predecessorIndexes);
      expect((await sql`SELECT preserved_predecessor_fixture FROM user_machines`.execute(db.executor)).rows)
        .toEqual([{ preserved_predecessor_fixture: "retained" }]);
      let called = false;
      await runPlatformMigration<PlatformDatabase>(db.executor, async () => { called = true; }, { revision: { generation: 17, fingerprint: "predecessor17" } });
      expect(called).toBe(false);
    });
    it.skipIf(!postgres)("serializes exact settlement versus waiver without a double-release or owner re-debit", async () => {
      const secondRepo = createAiFundedPolicyRepository({ db: other, credentialHashSecret: "h".repeat(32), now: () => new Date(clock) });
      const settlement = { reservationId: input.reservations[0].reservationId, tokenId: credential.tokenId,
        mode: "exact" as const, actualCostMicrousd: 40 };
      const result = await Promise.allSettled([waiver()(input, { apply: true }), secondRepo.finalizeReservation(settlement)]);
      expect(result[1].status).toBe("fulfilled");
      const row = (await snapshot()).rows[0];
      expect(row.status).toBe("settled"); expect(Number(row.actual_microusd)).toBe(40);
      expect(Number((await snapshot()).balances[0].reserved_microusd)).toBe(0);
      const charge = (await snapshot()).ledger.filter((item) => item.reservation_id === row.reservation_id)
        .reduce((sum, item) => sum + Number(item.amount_microusd), 0);
      expect(charge).toBe(row.charge_waiver === null ? -40 : 0);
      if (row.charge_waiver !== null) expect(result[0].status).toBe("fulfilled");
      else expect(result[0]).toMatchObject({ status: "rejected", reason: { code: "reservation_closed" } });
    });
    it.skipIf(!postgres)("executes the actual default-dry-run CLI and exact-fingerprint apply against the disposable schema", async () => {
      const directory = await mkdtemp(join(tmpdir(), "matrix-waiver-review-"));
      try {
        const path = join(directory, "review.json");
        await writeFile(path, JSON.stringify(input), { flag: "wx", mode: 0o600 });
        const before = await snapshot();
        const run = (arguments_: string[]) => promisify(execFile)("bun", ["scripts/waive-expired-funded-usage.ts", path, ...arguments_],
          { env: { ...process.env, PLATFORM_DATABASE_URL: connectionString,
            ACCOUNT_DELETION_SECRET: undefined, ACCOUNT_DELETION_ENABLED: undefined }, timeout: 30_000, maxBuffer: 32 * 1024 });
        const dry = JSON.parse((await run([])).stdout);
        expect(dry).toMatchObject({ mode: "dry-run", releasedMicrousd: 1_000 });
        expect(await snapshot()).toEqual(before);
        await expect(run(["--apply", "--reviewed-sha256", "0".repeat(64)])).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        const applied = JSON.parse((await run(["--apply", "--reviewed-sha256", dry.fingerprint])).stdout);
        expect(applied).toMatchObject({ mode: "applied", fingerprint: dry.fingerprint });
        expect((await snapshot()).rows[0]).toMatchObject({ status: "waived", actual_microusd: null });
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  });
