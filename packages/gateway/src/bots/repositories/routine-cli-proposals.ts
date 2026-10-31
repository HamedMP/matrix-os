import type { Selectable } from "kysely";
import type { OwnerBotDatabase } from "../database.js";
import type { RoutineCliScope } from "./routine-cli-preferences.js";
import { toSafeInteger, type BotExecutor } from "./shared.js";
import { RoutineCliError } from "../routine-cli-errors.js";
export type RoutineCliProposalStage = "reserved" | "submitting" | "canonical_queued" | "canonical_accepted" | "target_task_claimed" | "pending_approval" | "rejected" | "unknown";
export type RoutineCliProposalRecord = Selectable<OwnerBotDatabase["routine_cli_proposals"]>;
export function createRoutineCliProposalsRepository(db: BotExecutor) {
  const get = async (scope: RoutineCliScope, requestId: string, ex: BotExecutor = db, lock = false) => {
    let query = ex.selectFrom("routine_cli_proposals").selectAll().where("owner_id", "=", scope.ownerId)
      .where("computer_id", "=", scope.computerId).where("client_request_id", "=", requestId);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  };
  return { get,
    async reserve(input: { scope: RoutineCliScope; requestId: string; canonicalRequestId: string; requestHash: string; now: string }, ex: BotExecutor) {
      if (!ex.isTransaction) throw new RoutineCliError("unavailable");
      await ex.insertInto("routine_cli_proposals").values({ owner_id: input.scope.ownerId, computer_id: input.scope.computerId,
        client_request_id: input.requestId, canonical_request_id: input.canonicalRequestId, request_hash: input.requestHash,
        stage: "reserved", run_id: null, task_id: null, interaction_id: null, runtime_handle: null, execution_generation: null,
        created_at: input.now, updated_at: input.now }).execute();
    },
    async advance(record: RoutineCliProposalRecord, update: { stage: RoutineCliProposalStage; run_id?: string; task_id?: string; interaction_id?: string; runtime_handle?: string; execution_generation?: string }, now: string, ex: BotExecutor) {
      if (!ex.isTransaction) throw new RoutineCliError("unavailable");
      const row = await ex.updateTable("routine_cli_proposals").set({ ...update, revision: toSafeInteger(record.revision) + 1, updated_at: now })
        .where("owner_id", "=", record.owner_id).where("computer_id", "=", record.computer_id).where("client_request_id", "=", record.client_request_id)
        .where("revision", "=", toSafeInteger(record.revision)).where("stage", "=", record.stage).returningAll().executeTakeFirst();
      if (!row) throw new RoutineCliError("revision_conflict");
      return row;
    },
    async byCanonical(ownerId: string, canonicalRequestId: string, ex: BotExecutor = db) {
      return ex.selectFrom("routine_cli_proposals").selectAll().where("owner_id", "=", ownerId).where("canonical_request_id", "=", canonicalRequestId).executeTakeFirst();
    },
  };
}
