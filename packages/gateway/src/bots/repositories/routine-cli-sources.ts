import { sql, type Selectable, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../database.js";
import type { RoutineCliScope } from "./routine-cli-preferences.js";
import { RoutineCliError } from "../routine-cli-errors.js";
import type { BotExecutor } from "./shared.js";

type SourceRow = Selectable<OwnerBotDatabase["routine_cli_sources"]>;
type CapabilityRow = Selectable<OwnerBotDatabase["routine_cli_capabilities"]>;
const scoped = (scope: RoutineCliScope) => [scope.ownerId, scope.computerId];
export async function lockRoutineCliSourceAdmission(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope): Promise<void> {
  if (!trx.isTransaction) throw new RoutineCliError("unavailable");
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["routine-cli-source-admission", ...scoped(scope)])}, 0))`.execute(trx);
}
/** All generation rotation, revocation, issue, target validation and consumption take this gate. */
export async function lockRoutineCliSourceGeneration(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope, key: string): Promise<void> {
  if (!trx.isTransaction) throw new RoutineCliError("unavailable");
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["routine-cli-source-generation", ...scoped(scope), key])}, 0))`.execute(trx);
}

/** Internal storage. The service owns validation, limits and mandatory lifecycle/policy callbacks. */
export function createRoutineCliSourcesRepository(db: BotExecutor) {
  const source = async (scope: RoutineCliScope, sourceId: string, executor: BotExecutor = db, locked = false): Promise<SourceRow | undefined> => {
    let query = executor.selectFrom("routine_cli_sources").selectAll().where("source_id", "=", sourceId)
      .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId);
    if (locked) query = query.forUpdate();
    return query.executeTakeFirst();
  };
  const capability = async (scope: RoutineCliScope, hash: string, executor: BotExecutor = db, locked = false): Promise<CapabilityRow | undefined> => {
    let query = executor.selectFrom("routine_cli_capabilities").selectAll().where("token_hash", "=", hash)
      .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId);
    if (locked) query = query.forUpdate();
    return query.executeTakeFirst();
  };
  return {
    source, capability,
    async activeSources(scope: RoutineCliScope, now: string, excludingKey: string, executor: BotExecutor): Promise<number> {
      const row = await executor.selectFrom("routine_cli_sources").select(eb => eb.fn.countAll<string>().as("n"))
        .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId)
        .where("revoked_at", "is", null).where("expires_at", ">", now).where("source_key", "!=", excludingKey).executeTakeFirstOrThrow();
      return Number(row.n);
    },
    async register(row: SourceRow, trx: Transaction<OwnerBotDatabase>, now: string): Promise<void> {
      await trx.updateTable("routine_cli_sources").set({ revoked_at: now })
        .where("owner_id", "=", row.owner_id).where("computer_id", "=", row.computer_id)
        .where("source_key", "=", row.source_key).where("revoked_at", "is", null).execute();
      const saved = await trx.insertInto("routine_cli_sources").values(row).onConflict(conflict => conflict.column("source_id").doNothing())
        .returning("source_id").executeTakeFirst();
      if (!saved) throw new RoutineCliError("revision_conflict");
    },
    async revoke(scope: RoutineCliScope, sourceId: string, now: string, trx: Transaction<OwnerBotDatabase>): Promise<void> {
      await trx.updateTable("routine_cli_sources").set({ revoked_at: now }).where("owner_id", "=", scope.ownerId)
        .where("computer_id", "=", scope.computerId).where("source_id", "=", sourceId).where("revoked_at", "is", null).execute();
    },
    async activeCapabilities(scope: RoutineCliScope, now: string, sourceId: string | undefined, executor: BotExecutor): Promise<number> {
      let query = executor.selectFrom("routine_cli_capabilities as c").innerJoin("routine_cli_sources as s", "s.source_id", "c.source_id")
        .select(eb => eb.fn.countAll<string>().as("n")).where("c.owner_id", "=", scope.ownerId).where("c.computer_id", "=", scope.computerId)
        .where("c.token_hash", "is not", null).where("c.consumed_at", "is", null).where("c.expires_at", ">", now)
        .where("s.revoked_at", "is", null).where("s.expires_at", ">", now);
      if (sourceId) query = query.where("c.source_id", "=", sourceId);
      return Number((await query.executeTakeFirstOrThrow()).n);
    },
    async issue(row: CapabilityRow, trx: Transaction<OwnerBotDatabase>): Promise<void> {
      const saved = await trx.insertInto("routine_cli_capabilities").values(row)
        .onConflict(conflict => conflict.columns(["source_id", "invocation_id"]).doNothing()).returning("invocation_id").executeTakeFirst();
      if (!saved) throw new RoutineCliError("revision_conflict");
    },
    async consume(scope: RoutineCliScope, tokenHash: string, now: string, trx: Transaction<OwnerBotDatabase>): Promise<void> {
      const saved = await trx.updateTable("routine_cli_capabilities").set({ consumed_at: now })
        .where("owner_id", "=", scope.ownerId).where("computer_id", "=", scope.computerId)
        .where("token_hash", "=", tokenHash).where("consumed_at", "is", null).returning("invocation_id").executeTakeFirst();
      if (!saved) throw new RoutineCliError("permission_denied");
    },
    async cleanup(scope: RoutineCliScope, now: string, limit: number, trx: Transaction<OwnerBotDatabase>): Promise<number> {
      // Clear secret material but retain unique host-invocation tombstones, preventing later reissue.
      const rows = await sql`WITH expired AS (
        SELECT source_id, invocation_id FROM routine_cli_capabilities
        WHERE owner_id = ${scope.ownerId} AND computer_id = ${scope.computerId}
          AND token_hash IS NOT NULL AND expires_at <= ${now}::timestamptz
        ORDER BY expires_at, source_id, invocation_id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) UPDATE routine_cli_capabilities AS c SET token_hash = NULL FROM expired
        WHERE c.source_id = expired.source_id AND c.invocation_id = expired.invocation_id
        RETURNING c.invocation_id`.execute(trx);
      return rows.rows.length;
    },
  };
}
