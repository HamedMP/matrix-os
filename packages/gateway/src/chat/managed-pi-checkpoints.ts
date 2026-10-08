/**
 * Tool checkpoints (`managed_pi_tool_checkpoints`). The broker writes `prepared`
 * before dispatching a tool call and `observed_complete` or `effect_unknown`
 * after it. After a crash, `dispatched` rows without an outcome become
 * `effect_unknown` and are never replayed automatically; only a `read` may
 * be retried, at most twice.
 */
import { encodeCheckpointAction } from "../bots/repositories/serialization.js";
import type { Selectable } from "kysely";
import type { BotCheckpointPhase, BotEffectClass, BotToolCheckpointsTable } from "../bots/database.js";
import { BotStateError, isoTimestamp, newBotStateId, type BotExecutor } from "../bots/repositories/shared.js";

const MAX_READ_RETRIES = 2;
const MAX_RECONCILE_BATCH = 200;
const MAX_RUN_CHECKPOINTS_LISTED = 120;

export interface BotToolCheckpoint {
  checkpointId: string;
  ownerId: string;
  chatId: string;
  runId: string;
  toolCallId: string;
  action: Record<string, unknown>;
  effectClass: BotEffectClass;
  phase: BotCheckpointPhase;
  outcomeRef: string | null;
  readRetries: number;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: Selectable<Omit<BotToolCheckpointsTable, "task_id"> & { chat_id: string }>): BotToolCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    ownerId: row.owner_id,
    chatId: row.chat_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    action: typeof row.action === "string" ? JSON.parse(row.action) as Record<string, unknown> : row.action,
    effectClass: row.effect_class,
    phase: row.phase,
    outcomeRef: row.outcome_ref,
    readRetries: row.read_retries,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export function createManagedPiCheckpointsRepository(db: BotExecutor) {
  async function move(input: {
    ownerId: string;
    checkpointId: string;
    from: readonly BotCheckpointPhase[];
    to: BotCheckpointPhase;
    outcomeRef?: string;
    now: string;
  }, executor: BotExecutor): Promise<BotToolCheckpoint> {
    const row = await executor.updateTable("managed_pi_tool_checkpoints")
      .set((eb) => ({
        phase: input.to,
        outcome_ref: input.outcomeRef ?? eb.ref("outcome_ref"),
        updated_at: input.now,
      }))
      .where("owner_id", "=", input.ownerId).where("checkpoint_id", "=", input.checkpointId)
      .where("phase", "in", [...input.from])
      .returningAll()
      .executeTakeFirst();
    if (row) return fromRow(row);
    const exists = await executor.selectFrom("managed_pi_tool_checkpoints").select("phase")
      .where("owner_id", "=", input.ownerId).where("checkpoint_id", "=", input.checkpointId).executeTakeFirst();
    throw new BotStateError(exists ? "invalid_transition" : "not_found");
  }

  return {
    /**
     * Records a tool call before dispatch. Idempotent per run and tool call ID;
     * the same ID with a different action is a conflict.
     */
    async prepare(input: {
      ownerId: string;
      chatId: string;
      runId: string;
      toolCallId: string;
      action: Record<string, unknown>;
      effectClass: BotEffectClass;
      now: string;
    }, executor: BotExecutor = db): Promise<{ checkpoint: BotToolCheckpoint; created: boolean }> {
      const { action, actionHash } = encodeCheckpointAction(input.action);
      const inserted = await executor.insertInto("managed_pi_tool_checkpoints").values({
        checkpoint_id: newBotStateId("ckpt"),
        owner_id: input.ownerId,
        chat_id: input.chatId,
        run_id: input.runId,
        tool_call_id: input.toolCallId,
        action,
        action_hash: actionHash,
        effect_class: input.effectClass,
        phase: "prepared",
        outcome_ref: null,
        created_at: input.now,
        updated_at: input.now,
      }).onConflict((conflict) => conflict.columns(["owner_id", "run_id", "tool_call_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { checkpoint: fromRow(inserted), created: true };
      const existing = await executor.selectFrom("managed_pi_tool_checkpoints").selectAll()
        .where("owner_id", "=", input.ownerId).where("run_id", "=", input.runId).where("tool_call_id", "=", input.toolCallId)
        .executeTakeFirst();
      if (!existing) throw new BotStateError("not_found");
      if (existing.action_hash !== actionHash || existing.chat_id !== input.chatId || existing.effect_class !== input.effectClass) {
        throw new BotStateError("conflict");
      }
      return { checkpoint: fromRow(existing), created: false };
    },
    markDispatched: (input: { ownerId: string; checkpointId: string; now: string }, executor: BotExecutor = db) =>
      move({ ...input, from: ["prepared"], to: "dispatched" }, executor),
    markObserved: (input: { ownerId: string; checkpointId: string; outcomeRef?: string; now: string }, executor: BotExecutor = db) =>
      move({ ...input, from: ["dispatched"], to: "observed_complete" }, executor),
    markEffectUnknown: (input: { ownerId: string; checkpointId: string; now: string }, executor: BotExecutor = db) =>
      move({ ...input, from: ["dispatched"], to: "effect_unknown" }, executor),
    /** A read whose effect is unknown may be dispatched again, at most twice. Writes and sends never are. */
    async retryRead(input: { ownerId: string; checkpointId: string; now: string }, executor: BotExecutor = db): Promise<BotToolCheckpoint> {
      const row = await executor.updateTable("managed_pi_tool_checkpoints")
        .set((eb) => ({ phase: "dispatched", read_retries: eb("read_retries", "+", 1), updated_at: input.now }))
        .where("owner_id", "=", input.ownerId).where("checkpoint_id", "=", input.checkpointId)
        .where("phase", "=", "effect_unknown").where("effect_class", "=", "read")
        .where("read_retries", "<", MAX_READ_RETRIES)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new BotStateError("invalid_transition");
      return fromRow(row);
    },
    /**
     * Crash recovery: `dispatched` checkpoints last touched before `olderThan`
     * become `effect_unknown`. Bounded per call; returns how many changed.
     */
    async reconcileDispatched(input: { olderThan: string; now: string; limit?: number }, executor: BotExecutor = db): Promise<number> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_RECONCILE_BATCH), MAX_RECONCILE_BATCH));
      const rows = await executor.updateTable("managed_pi_tool_checkpoints")
        .set({ phase: "effect_unknown", updated_at: input.now })
        .where("checkpoint_id", "in", (eb) => eb.selectFrom("managed_pi_tool_checkpoints").select("checkpoint_id")
          .where("phase", "=", "dispatched").where("updated_at", "<", input.olderThan)
          .orderBy("updated_at", "asc").limit(limit))
        .where("phase", "=", "dispatched")
        .returning("checkpoint_id")
        .execute();
      return rows.length;
    },
    async listForRun(input: { ownerId: string; runId: string }, executor: BotExecutor = db): Promise<BotToolCheckpoint[]> {
      const rows = await executor.selectFrom("managed_pi_tool_checkpoints").selectAll()
        .where("owner_id", "=", input.ownerId).where("run_id", "=", input.runId)
        .orderBy("created_at", "asc")
        .limit(MAX_RUN_CHECKPOINTS_LISTED)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type ManagedPiCheckpointsRepository = ReturnType<typeof createManagedPiCheckpointsRepository>;
