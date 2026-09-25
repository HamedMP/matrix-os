import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID, type JevEmailTriageResult } from "@matrix-os/contracts";
import { sql, type Dialect } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

const completed: JevEmailTriageResult = {
  requestId: "jev_req_request_123",
  recipe: "email-triage-v1",
  model: JEV_MODEL_ID,
  latencyMs: 1,
  answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: 0.5 })),
};
const key = { ownerId: "owner_a", idempotencyKey: "thread:abc123", payloadHash: "a".repeat(64) };

describe("Jev evaluation repository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: JevEvaluationRepository;
  let clock: Date;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    clock = new Date("2026-09-22T10:00:00.000Z");
    repository = new JevEvaluationRepository(pglite.dialect, {
      now: () => clock,
    });
    await repository.bootstrap();
  });

  afterEach(async () => repository.destroy());

  it("atomically claims and returns a completed result within the owner scope", async () => {
    const [first, second] = await Promise.all([repository.claim(key), repository.claim(key)]);
    expect([first.kind, second.kind].sort()).toEqual(["claimed", "pending"]);
    await repository.complete({ ...key, result: completed });
    await expect(repository.claim(key)).resolves.toEqual({ kind: "completed", result: completed });
    await expect(repository.claim({ ...key, ownerId: "owner_b" })).resolves.toEqual({ kind: "claimed" });
  });

  it("detects changed payloads and preserves unknown outcomes", async () => {
    await repository.claim(key);
    await expect(repository.claim({ ...key, payloadHash: "b".repeat(64) })).resolves.toEqual({ kind: "conflict" });
    await repository.markUnknown(key);
    await expect(repository.claim(key)).resolves.toEqual({ kind: "unknown" });
  });

  it("retains a completed key after result retention without repeating a paid evaluation", async () => {
    await repository.claim(key);
    await repository.complete({ ...key, result: completed });
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60_000 + 1);

    const restarted = new JevEvaluationRepository(repository.kysely, { now: () => clock });
    await expect(restarted.claim(key)).resolves.toEqual({ kind: "result_expired" });
    await expect(restarted.claim({ ...key, payloadHash: "b".repeat(64) }))
      .resolves.toEqual({ kind: "conflict" });
    await expect(restarted.claim({ ...key, ownerId: "owner_b" }))
      .resolves.toEqual({ kind: "claimed" });
    const row = await repository.kysely.selectFrom("jev_evaluations")
      .select(["status", "result"])
      .where("owner_id", "=", key.ownerId)
      .where("idempotency_key", "=", key.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "completed_pruned", result: null });
  });

  it("retains an unknown-outcome key after seven days, including concurrent retry attempts", async () => {
    await repository.claim(key);
    await repository.markUnknown(key);
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60_000 + 1);

    const restarted = new JevEvaluationRepository(repository.kysely, { now: () => clock });
    const claims = await Promise.all([repository.claim(key), restarted.claim(key)]);
    expect(claims).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    await expect(restarted.claim({ ...key, payloadHash: "b".repeat(64) }))
      .resolves.toEqual({ kind: "conflict" });
  });

  it("releases only matching pending claims", async () => {
    await repository.claim(key);
    await repository.release({ ...key, payloadHash: "b".repeat(64) });
    await expect(repository.claim(key)).resolves.toEqual({ kind: "pending" });
    await repository.release(key);
    await expect(repository.claim(key)).resolves.toEqual({ kind: "claimed" });
  });

  it("rolls back the table when its index cannot be created", async () => {
    const isolated = await KyselyPGlite.create();
    const base = isolated.dialect;
    const failingDialect: Dialect = {
      createAdapter: () => base.createAdapter(),
      createQueryCompiler: () => base.createQueryCompiler(),
      createIntrospector: (db) => base.createIntrospector(db),
      createDriver: () => {
        const driver = base.createDriver();
        return {
          init: () => driver.init(),
          acquireConnection: async () => {
            const connection = await driver.acquireConnection();
            return {
              executeQuery: async <R>(query: Parameters<typeof connection.executeQuery>[0]) => {
                if (query.sql.includes("CREATE INDEX IF NOT EXISTS idx_jev_evaluations_updated_at")) {
                  throw new Error("injected index failure");
                }
                return connection.executeQuery<R>(query);
              },
              streamQuery: <R>(query: Parameters<typeof connection.streamQuery>[0], chunkSize?: number) =>
                connection.streamQuery<R>(query, chunkSize),
            };
          },
          beginTransaction: (connection, settings) => driver.beginTransaction(connection, settings),
          commitTransaction: (connection) => driver.commitTransaction(connection),
          rollbackTransaction: (connection) => driver.rollbackTransaction(connection),
          releaseConnection: (connection) => driver.releaseConnection(connection),
          destroy: () => driver.destroy(),
        };
      },
    };
    const failing = new JevEvaluationRepository(failingDialect);
    try {
      await expect(failing.bootstrap()).rejects.toThrow("injected index failure");
      const result = await sql<{ table_name: string | null }>`SELECT to_regclass('public.jev_evaluations')::text AS table_name`
        .execute(failing.kysely);
      expect(result.rows[0]?.table_name).toBeNull();
    } finally {
      await failing.destroy();
    }
  });
});
