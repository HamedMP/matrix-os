import {
  JevEmailTriageResultSchema,
  type JevEmailTriageResult,
} from "@matrix-os/contracts";
import {
  Kysely,
  sql,
  type ColumnType,
  type Dialect,
} from "kysely";

const PENDING_STALE_MS = 15 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const RESULT_PRUNE_BATCH_SIZE = 100;

interface JevEvaluationsTable {
  owner_id: string;
  idempotency_key: string;
  payload_hash: string;
  status: "pending" | "completed" | "completed_pruned" | "unknown";
  result: ColumnType<unknown | null, unknown | null | undefined, unknown | null>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

interface JevDatabase {
  jev_evaluations: JevEvaluationsTable;
}

export type JevEvaluationClaim =
  | { kind: "claimed" }
  | { kind: "completed"; result: JevEmailTriageResult }
  | { kind: "pending" | "unknown" | "conflict" | "result_expired" };

interface EvaluationKey {
  ownerId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface JevEvaluationStore {
  claim(input: EvaluationKey): Promise<JevEvaluationClaim>;
  complete(input: EvaluationKey & { result: JevEmailTriageResult }): Promise<void>;
  markUnknown(input: EvaluationKey): Promise<void>;
  release(input: EvaluationKey): Promise<void>;
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

async function pruneExpiredCompletedResults(db: Kysely<JevDatabase>, retentionCutoff: Date): Promise<void> {
  await sql`
    WITH due AS (
      SELECT owner_id, idempotency_key
      FROM jev_evaluations
      WHERE status = 'completed' AND updated_at < ${retentionCutoff}
      ORDER BY updated_at, owner_id, idempotency_key
      LIMIT ${RESULT_PRUNE_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jev_evaluations AS evaluation
    SET status = 'completed_pruned', result = NULL
    FROM due
    WHERE evaluation.owner_id = due.owner_id
      AND evaluation.idempotency_key = due.idempotency_key
  `.execute(db);
}

export class JevEvaluationRepository implements JevEvaluationStore {
  readonly kysely: Kysely<JevDatabase>;
  private readonly ownsConnection: boolean;
  private readonly now: () => Date;

  constructor(
    dialectOrKysely: Dialect | Kysely<JevDatabase>,
    options: { now?: () => Date } = {},
  ) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
    } else {
      this.kysely = new Kysely<JevDatabase>({ dialect: dialectOrKysely });
      this.ownsConnection = true;
    }
    this.now = options.now ?? (() => new Date());
  }

  async bootstrap(): Promise<void> {
    await this.kysely.transaction().execute(async (trx) => {
      // Serialize schema creation/migration across Gateway processes sharing
      // this Postgres schema. CREATE TABLE IF NOT EXISTS alone is not a lock.
      await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('jev_evaluations'))`.execute(trx);
      await sql`
      CREATE TABLE IF NOT EXISTS jev_evaluations (
        owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 240),
        payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'completed_pruned', 'unknown')),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, idempotency_key),
        CHECK ((status = 'completed' AND result IS NOT NULL) OR (status <> 'completed' AND result IS NULL))
      )
      `.execute(trx);
      const statusConstraint = await sql<{ supports_pruned: boolean }>`
        SELECT COALESCE(bool_or(position('completed_pruned' in pg_get_constraintdef(oid)) > 0), false) AS supports_pruned
        FROM pg_constraint
        WHERE conrelid = 'jev_evaluations'::regclass AND conname = 'jev_evaluations_status_check'
      `.execute(trx);
      if (!statusConstraint.rows[0]?.supports_pruned) {
        // Existing installations have the original three-status constraint.
        // Change only that constraint; preserve all rows and the primary key.
        await sql`ALTER TABLE jev_evaluations DROP CONSTRAINT IF EXISTS jev_evaluations_status_check`.execute(trx);
        await sql`
          ALTER TABLE jev_evaluations ADD CONSTRAINT jev_evaluations_status_check
          CHECK (status IN ('pending', 'completed', 'completed_pruned', 'unknown'))
        `.execute(trx);
      }
      await sql`CREATE INDEX IF NOT EXISTS idx_jev_evaluations_updated_at ON jev_evaluations (updated_at)`
        .execute(trx);
    });
  }

  async pruneExpiredCompletedResults(): Promise<void> {
    await pruneExpiredCompletedResults(this.kysely, new Date(this.now().getTime() - RETENTION_MS));
  }

  async claim(input: EvaluationKey): Promise<JevEvaluationClaim> {
    const now = this.now();
    const retentionCutoff = new Date(now.getTime() - RETENTION_MS);
    return this.kysely.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto("jev_evaluations").values({
        owner_id: input.ownerId,
        idempotency_key: input.idempotencyKey,
        payload_hash: input.payloadHash,
        status: "pending",
        result: null,
        created_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.columns(["owner_id", "idempotency_key"]).doNothing())
        .returning("owner_id").executeTakeFirst();
      let outcome: JevEvaluationClaim;
      if (inserted) {
        outcome = { kind: "claimed" };
      } else {
        // Lock the requested key before any cleanup rows. Two callers with
        // different target keys can then skip one another during the sweep.
        const row = await trx.selectFrom("jev_evaluations").selectAll()
          .where("owner_id", "=", input.ownerId)
          .where("idempotency_key", "=", input.idempotencyKey)
          .forUpdate().executeTakeFirstOrThrow();
        if (row.payload_hash !== input.payloadHash) {
          outcome = { kind: "conflict" };
        } else if (row.status === "completed") {
          const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
          if (updatedAt < retentionCutoff) {
            await trx.updateTable("jev_evaluations").set({ status: "completed_pruned", result: null })
              .where("owner_id", "=", input.ownerId)
              .where("idempotency_key", "=", input.idempotencyKey)
              .where("status", "=", "completed").executeTakeFirst();
            outcome = { kind: "result_expired" };
          } else {
            outcome = { kind: "completed", result: JevEmailTriageResultSchema.parse(parseJson(row.result)) };
          }
        } else if (row.status === "completed_pruned") {
          outcome = { kind: "result_expired" };
        } else if (row.status === "unknown") {
          outcome = { kind: "unknown" };
        } else if (row.status === "pending") {
          const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
          if (updatedAt.getTime() <= now.getTime() - PENDING_STALE_MS) {
            await trx.updateTable("jev_evaluations").set({ status: "unknown", updated_at: now })
              .where("owner_id", "=", input.ownerId)
              .where("idempotency_key", "=", input.idempotencyKey)
              .where("status", "=", "pending").executeTakeFirst();
            outcome = { kind: "unknown" };
          } else {
            outcome = { kind: "pending" };
          }
        } else {
          throw new Error("Invalid Jev evaluation status");
        }
      }

      // Background maintenance handles unrelated expired rows. The requested
      // key is resolved under its own lock before this transaction commits.
      return outcome;
    });
  }

  async complete(input: EvaluationKey & { result: JevEmailTriageResult }): Promise<void> {
    const result = JevEmailTriageResultSchema.parse(input.result);
    const updated = await this.kysely.updateTable("jev_evaluations").set({
      status: "completed",
      result: JSON.stringify(result),
      updated_at: this.now(),
    }).where("owner_id", "=", input.ownerId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("payload_hash", "=", input.payloadHash)
      .where("status", "=", "pending")
      .returning("owner_id").executeTakeFirst();
    if (!updated) throw new Error("Jev evaluation completion lost its claim");
  }

  async markUnknown(input: EvaluationKey): Promise<void> {
    await this.kysely.updateTable("jev_evaluations").set({
      status: "unknown", result: null, updated_at: this.now(),
    }).where("owner_id", "=", input.ownerId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("payload_hash", "=", input.payloadHash)
      .where("status", "=", "pending").execute();
  }

  async release(input: EvaluationKey): Promise<void> {
    await this.kysely.deleteFrom("jev_evaluations")
      .where("owner_id", "=", input.ownerId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("payload_hash", "=", input.payloadHash)
      .where("status", "=", "pending").execute();
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) await this.kysely.destroy();
  }
}
