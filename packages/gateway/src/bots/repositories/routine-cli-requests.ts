import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../database.js";
import type { RoutineCliMutationOperation, RoutineCliAdmission } from "../routine-cli-requests.js";
import type { RoutineCliSourceContext } from "../routine-cli-source-context.js";
import type { RoutineCliVerifiedInvocation } from "../routine-cli-source.js";
import type { RoutineCliResolvedTarget } from "../routine-cli-targets.js";
import type { RoutineCliScope } from "./routine-cli-preferences.js";
import { RoutineCliError } from "../routine-cli-errors.js";
import { isoTimestamp, toSafeInteger, type BotExecutor } from "./shared.js";
export interface RoutineCliRequestRecord {
  requestId: string; operationDigest: string; operation: RoutineCliMutationOperation;
  source: RoutineCliSourceContext; invocation: RoutineCliVerifiedInvocation; target: RoutineCliResolvedTarget;
  admission: RoutineCliAdmission; revision: number; createdAt: string;
}
export async function lockRoutineCliRequest(trx: Transaction<OwnerBotDatabase>, scope: RoutineCliScope, requestId: string) {
  if (!trx.isTransaction) throw new RoutineCliError("unavailable");
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  // PostgreSQL UUID keys are case-insensitive; the serialization key must name that same identity.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["routine-cli-request", scope.ownerId, scope.computerId, requestId.toLowerCase()])}, 0))`.execute(trx);
}
export function createRoutineCliRequestsRepository(db: BotExecutor) {
  const get = async (scope: RoutineCliScope, requestId: string, executor: BotExecutor = db): Promise<RoutineCliRequestRecord | undefined> => {
    const row = await executor.selectFrom("routine_cli_requests").selectAll().where("owner_id", "=", scope.ownerId)
      .where("computer_id", "=", scope.computerId).where("client_request_id", "=", requestId).executeTakeFirst();
    return row ? { requestId: row.client_request_id, operationDigest: row.operation_digest, operation: row.operation,
      source: row.source_context, invocation: row.source_invocation, target: row.target_snapshot,
      admission: row.admission, revision: toSafeInteger(row.revision), createdAt: isoTimestamp(row.created_at) } : undefined;
  };
  return { get,
    async insert(scope: RoutineCliScope, record: Omit<RoutineCliRequestRecord, "revision">, trx: Transaction<OwnerBotDatabase>) {
      if (!trx.isTransaction) throw new RoutineCliError("unavailable");
      const row = await trx.insertInto("routine_cli_requests").values({ owner_id: scope.ownerId, computer_id: scope.computerId,
        client_request_id: record.requestId, operation_digest: record.operationDigest, operation: record.operation,
        source_context: record.source, source_invocation: record.invocation, target_snapshot: record.target,
        admission: record.admission, revision: 1, created_at: record.createdAt })
        .onConflict(conflict => conflict.columns(["owner_id", "computer_id", "client_request_id"]).doNothing()).returning("client_request_id").executeTakeFirst();
      if (!row) throw new RoutineCliError("request_conflict");
      return (await get(scope, record.requestId, trx))!;
    },
  };
}
