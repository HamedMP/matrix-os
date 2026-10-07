import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { migratePlatformSchema } from "../../packages/platform/src/database/migrate.js";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";
import { runPlatformMigration } from "../../packages/platform/src/migration-runner.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const predecessors = [
  { generation: 11, fingerprint: "7d1eb484389f19443b36e27f70edbb769ac158d4862b6546e358f185f2e0a284",
    name: "single-obligation", recoverySlots: false, creditHistory: false },
  { generation: 12, fingerprint: "3d7b8eb2a8fab86c32a4d657e26ce04155f64877c5db881cd258c6fddcc7a952",
    name: "credit-history main", recoverySlots: false, creditHistory: true },
  { generation: 12, fingerprint: "6bc02a97b2de78c806fccd62fe4ad7e389053c9aa6a96ddaf8d8111e3106feb2",
    name: "bounded-recovery branch", recoverySlots: true, creditHistory: false },
] as const;

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
for (const predecessor of predecessors) {
for (const engine of ["PGlite", "PostgreSQL"] as const) {
const previousRevision = { generation: predecessor.generation, fingerprint: predecessor.fingerprint };
describe.skipIf(engine === "PostgreSQL" && !databaseUrl)(`generation ${predecessor.generation} ${predecessor.name} upgrade (${engine})`, () => {
  let db: PlatformDB;
  let admin: pg.Pool | undefined;
  let schema: string | undefined;
  let reservationId: string;
  let now: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  const snapshot = async () => ({
    balances: await db.executor.selectFrom("ai_funded_runtime_balances").selectAll().execute(),
    ledger: await db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute(),
    grants: await db.executor.selectFrom("ai_funded_promotional_grant_balances").selectAll().execute(),
    allocations: await db.executor.selectFrom("ai_funded_reservation_promotional_allocations").selectAll().execute(),
  });
  const historyIndexes = async () => (await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()
      AND indexname IN ('idx_ai_funded_ledger_history_cursor', 'idx_ai_funded_ledger_history_page')
      ORDER BY indexname`.execute(db.executor)).rows.map((row) => row.indexname);
  beforeEach(async () => {
    if (engine === "PostgreSQL") {
      // Each case owns a schema on the disposable test server; never use a
      // live platform database or share migration state with another suite.
      schema = `funded_recovery_${randomUUID().replaceAll("-", "")}`;
      admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      db = createPlatformDb(url.toString());
      await db.ready;
    } else {
      ({ db } = await createTestPlatformDb());
    }
    now = new Date("2026-10-04T00:00:00.000Z");
    const identity = { ownerId: "legacy_owner", machineId: "legacy_machine", runtimeSlot: "primary" };
    repo = createAiFundedPolicyRepository({ db, now: () => now, credentialHashSecret: "h".repeat(32), inFlightTtlMs: 60_000 });
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: "legacy", status: "running",
      activationState: "authorized", imageVersion: "test", provisionedAt: now.toISOString() });
    const modelId = "anthropic/claude-sonnet-5";
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1_000, expiresAt: null });
    await repo.grantCredit({ entryId: "legacy_grant", identity, kind: "promotional_grant", amountMicrousd: 1_000,
      sourceReference: "legacy-proof", expiresAt: "2026-11-01T00:00:00.000Z" });
    const token = (await repo.issueRuntimeCredential(identity)).credential;
    const auth = await repo.authorize({ credential: token.token, requestId: "legacy_request", modelId, maxCostMicrousd: 100, billingMode: "usage" });
    reservationId = auth.reservation.reservationId;
    await repo.startReservation({ reservationId, tokenId: token.tokenId });
    const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", reservationId).executeTakeFirstOrThrow();
    now = new Date(now.getTime() + 20 * 60_000);
    await repo.releaseExecutionAdmission(identity, { expectedOwnerId: identity.ownerId, reservationId, tokenId: token.tokenId,
      expectedRequestId: row.request_id, expectedStartedAt: row.started_at!, expectedExpiresAt: row.expires_at,
      maximumLiabilityMicrousd: 100, localRunId: "legacy_run", localRunState: "failed",
      localRunEndedAt: new Date(Date.parse(row.started_at!) + 10_000).toISOString(), evidenceRef: "support:legacy",
      reviewer: "operator:qa", acceptUnknownUpstreamLiability: true });
    // Restore the independently versioned predecessor's changed columns/indexes and
    // marker while retaining real financial rows and immutable v1 receipts.
    await db.transaction(async (trx) => {
      if (!predecessor.recoverySlots) {
        await sql`ALTER TABLE ai_funded_usage_reservations DROP COLUMN execution_recovery_slot CASCADE`.execute(trx.executor);
        await sql`CREATE UNIQUE INDEX idx_ai_funded_unknown_admission_owner ON ai_funded_usage_reservations(owner_id)
          WHERE execution_admission_release IS NOT NULL AND actual_microusd IS NULL`.execute(trx.executor);
      }
      if (!predecessor.creditHistory) {
        await sql`DROP INDEX idx_ai_funded_ledger_history_cursor`.execute(trx.executor);
        await sql`DROP INDEX idx_ai_funded_ledger_history_page`.execute(trx.executor);
      }
      await sql`UPDATE platform_schema_revisions SET generation=${predecessor.generation}, fingerprint=${predecessor.fingerprint} WHERE scope='core'`.execute(trx.executor);
    });
  });
  afterEach(async () => {
    try {
      await destroyTestPlatformDb(db);
    } finally {
      try {
        if (schema) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        schema = undefined;
        admin = undefined;
      }
    }
  });

  it("adds a non-null constrained default slot without changing money or immutable receipt", async () => {
    const before = await snapshot();
    const oldRow = (await sql<Record<string, unknown>>`SELECT * FROM ai_funded_usage_reservations`.execute(db.executor)).rows[0];
    await runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION });
    expect(await snapshot()).toEqual(before);
    const newRow = (await sql<Record<string, unknown>>`SELECT * FROM ai_funded_usage_reservations`.execute(db.executor)).rows[0];
    const { execution_recovery_slot, ...retained } = newRow;
    expect(execution_recovery_slot).toBe(0);
    const { execution_recovery_slot: _oldSlot, ...oldRetained } = oldRow;
    expect(retained).toEqual(oldRetained);
    expect(await historyIndexes()).toEqual([
      "idx_ai_funded_ledger_history_cursor", "idx_ai_funded_ledger_history_page",
    ]);
    const column = await sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='ai_funded_usage_reservations' AND column_name='execution_recovery_slot'`.execute(db.executor);
    expect(column.rows).toEqual([{ data_type: "smallint", is_nullable: "NO", column_default: "0" }]);
    const skipped = vi.fn();
    await runPlatformMigration(db.executor, skipped, { revision: previousRevision });
    expect(skipped).not.toHaveBeenCalled();
    expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db.executor)).rows).toEqual([PLATFORM_SCHEMA_REVISION]);
  });

  it.each(["json", "identity", "ceiling", "authorization", "receipt"])("aborts the entire migration on corrupt %s proof", async (kind) => {
    const row = (await sql<{ execution_admission_release: string; authorization_response: string }>`SELECT execution_admission_release, authorization_response FROM ai_funded_usage_reservations`.execute(db.executor)).rows[0];
    const audit = JSON.parse(row.execution_admission_release);
    const authorization = JSON.parse(row.authorization_response);
    if (kind === "identity") audit.request.expectedOwnerId = "another_owner";
    if (kind === "ceiling") audit.response.maximumLiabilityMicrousd = 99;
    if (kind === "receipt") audit.response.reservedMicrousd = 99;
    if (kind === "authorization") authorization.identity.machineId = "another_machine";
    await sql`UPDATE ai_funded_usage_reservations SET execution_admission_release=${kind === "json" ? "{" : JSON.stringify(audit)},
      authorization_response=${JSON.stringify(authorization)} WHERE reservation_id=${reservationId}`.execute(db.executor);
    const before = await snapshot();
    await expect(runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await snapshot()).toEqual(before);
    expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db.executor)).rows).toEqual([previousRevision]);
    expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_funded_usage_reservations'
      AND column_name='execution_recovery_slot'`.execute(db.executor)).rows).toEqual(
        predecessor.recoverySlots ? [{ column_name: 'execution_recovery_slot' }] : []);
    expect(await historyIndexes()).toEqual(predecessor.creditHistory ? [
      'idx_ai_funded_ledger_history_cursor', 'idx_ai_funded_ledger_history_page',
    ] : []);
    expect((await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_ai_funded_unknown_admission_owner'`.execute(db.executor)).rows[0].indexdef).toContain(predecessor.recoverySlots ? "(owner_id, execution_recovery_slot)" : "(owner_id)");
  });
  it.each(["count", "sum"])("refuses an impossible legacy owner %s set transactionally", async (kind) => {
    await sql`DROP INDEX idx_ai_funded_unknown_admission_owner`.execute(db.executor);
    const row = (await sql<Record<string, unknown>>`SELECT * FROM ai_funded_usage_reservations`.execute(db.executor)).rows[0];
    const audit = JSON.parse(String(row.execution_admission_release));
    const authorization = JSON.parse(String(row.authorization_response));
    const maximum = kind === "sum" ? 300_000 : 100;
    audit.request.maximumLiabilityMicrousd = maximum;
    audit.response.maximumLiabilityMicrousd = maximum;
    authorization.reservation.maxCostMicrousd = maximum;
    await sql`UPDATE ai_funded_usage_reservations SET execution_admission_release=${JSON.stringify(audit)},
      authorization_response=${JSON.stringify(authorization)}`.execute(db.executor);
    for (let index = 1; index < (kind === "count" ? 3 : 2); index++) {
      const key = `legacy_extra_${index}`;
      const extraAudit = structuredClone(audit);
      const extraAuthorization = structuredClone(authorization);
      extraAudit.request.reservationId = key; extraAudit.request.expectedRequestId = key;
      extraAuthorization.reservation.reservationId = key; extraAuthorization.reservation.requestId = key;
      await sql`INSERT INTO ai_funded_usage_reservations
        SELECT (jsonb_populate_record(NULL::ai_funded_usage_reservations, ${JSON.stringify({ ...row,
          reservation_id: key, request_id: key, authorization_response: JSON.stringify(extraAuthorization),
          execution_admission_release: JSON.stringify(extraAudit) })}::jsonb)).*`.execute(db.executor);
    }
    const before = await snapshot();
    await expect(runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION }))
      .rejects.toThrow("Funded recovery liability exceeds owner bound");
    expect(await snapshot()).toEqual(before);
    expect((await sql`SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope='core'`.execute(db.executor)).rows).toEqual([previousRevision]);
  });

  if (predecessor.recoverySlots) {
    it("preserves both occupied recovery slots through the composed upgrade", async () => {
      const identity = { ownerId: "legacy_owner", machineId: "legacy_machine", runtimeSlot: "primary" };
      const token = (await repo.issueRuntimeCredential(identity)).credential;
      const auth = await repo.authorize({ credential: token.token, requestId: "second_preview_unknown",
        modelId: "anthropic/claude-sonnet-5", maxCostMicrousd: 100, billingMode: "usage" });
      const key = { reservationId: auth.reservation.reservationId, tokenId: token.tokenId };
      await repo.startReservation(key);
      const row = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", key.reservationId).executeTakeFirstOrThrow();
      now = new Date(now.getTime() + 20 * 60_000);
      await repo.releaseExecutionAdmission(identity, { ...key, expectedOwnerId: identity.ownerId,
        expectedRequestId: row.request_id, expectedStartedAt: row.started_at!, expectedExpiresAt: row.expires_at,
        maximumLiabilityMicrousd: 100, localRunId: "second_preview_run", localRunState: "failed",
        localRunEndedAt: new Date(Date.parse(row.started_at!) + 10_000).toISOString(),
        evidenceRef: "support:second-preview", reviewer: "operator:qa", acceptUnknownUpstreamLiability: true });
      const before = await snapshot();
      const rowsBefore = await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .orderBy("execution_recovery_slot").execute();
      expect(rowsBefore.map((item) => item.execution_recovery_slot)).toEqual([0, 1]);
      await runPlatformMigration(db.executor, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION });
      expect(await snapshot()).toEqual(before);
      expect(await db.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .orderBy("execution_recovery_slot").execute()).toEqual(rowsBefore);
      expect(await historyIndexes()).toHaveLength(2);
    });
  }

});
}
}
