/**
 * Bot tasks (`bot_tasks`). Every transition is one conditional UPDATE: the
 * allowed source statuses and the caller's base revision are in the WHERE
 * clause. `active_ms` accrues only while a task is `running`, so waits for a
 * person or for capacity never count toward the active-work deadline.
 */
import { sql, type Selectable } from "kysely";
import type { BotTaskBudget, BotTasksTable, BotTaskStatus } from "../database.js";
import {
  BotStateError,
  isChatOwnerViolation,
  isoTimestamp,
  newBotStateId,
  optionalIsoTimestamp,
  toSafeInteger,
  withTransaction,
  type BotExecutor,
} from "./shared.js";

export const BOT_TASK_MAX_DEPTH = 3;
const MAX_OPEN_TASKS_LISTED = 20;
const TERMINAL: readonly BotTaskStatus[] = ["completed", "failed", "cancelled"];

export type BotBlockedReason =
  | "root_unavailable" | "grant_revoked" | "budget_exhausted" | "tool_unavailable" | "model_unavailable"
  | "funds_unavailable" | "capacity_unavailable" | "deadline_reached" | "policy_denied";

/** Source statuses each target may be reached from. */
const FROM: Readonly<Record<Exclude<BotTaskStatus, "queued">, readonly BotTaskStatus[]>> = {
  running: ["queued", "waiting_person", "waiting_capacity", "blocked"],
  waiting_person: ["running"],
  waiting_capacity: ["running"],
  // Revalidation can block a task that is queued or waiting, not only a running one.
  blocked: ["queued", "running", "waiting_person", "waiting_capacity"],
  completed: ["running"],
  failed: ["queued", "running", "waiting_person", "waiting_capacity", "blocked"],
  cancelled: ["queued", "running", "waiting_person", "waiting_capacity", "blocked"],
};

export interface BotTask {
  taskId: string;
  ownerId: string;
  botId: string;
  chatId: string;
  parentTaskId: string | null;
  status: BotTaskStatus;
  runId: string | null;
  budget: BotTaskBudget;
  activeMs: number;
  runningSince: string | null;
  blockedReason: BotBlockedReason | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: Selectable<BotTasksTable>): BotTask {
  const budget = typeof row.budget === "string" ? JSON.parse(row.budget) as BotTaskBudget : row.budget;
  return {
    taskId: row.task_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    parentTaskId: row.parent_task_id,
    status: row.status,
    runId: row.run_id,
    budget,
    activeMs: toSafeInteger(row.active_ms),
    runningSince: optionalIsoTimestamp(row.running_since),
    blockedReason: row.blocked_reason as BotBlockedReason | null,
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

/** Adds the time since `running_since` when a task leaves `running`. */
function accruedActiveMs(now: string) {
  return sql<number>`active_ms + CASE WHEN running_since IS NULL THEN 0
    ELSE GREATEST(0, floor(extract(epoch from (${now}::timestamptz - running_since)) * 1000))::bigint END`;
}

export function createBotTasksRepository(db: BotExecutor) {
  async function get(input: { ownerId: string; taskId: string }, executor: BotExecutor = db): Promise<BotTask | undefined> {
    const row = await executor.selectFrom("bot_tasks").selectAll()
      .where("owner_id", "=", input.ownerId).where("task_id", "=", input.taskId)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  return {
    get,
    /** Creates a queued task. A child task must share the owner and stay within the depth cap. */
    async create(input: {
      ownerId: string;
      botId: string;
      chatId: string;
      parentTaskId?: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotTask> {
      // The parent is locked so it cannot finish between the check and the insert.
      return withTransaction(executor, async (trx) => {
        let depth = 0;
        if (input.parentTaskId !== undefined) {
          const parent = await trx.selectFrom("bot_tasks").select(["status", "budget"])
            .where("owner_id", "=", input.ownerId).where("task_id", "=", input.parentTaskId)
            .forUpdate().executeTakeFirst();
          if (!parent || TERMINAL.includes(parent.status)) throw new BotStateError("not_found");
          const budget = typeof parent.budget === "string" ? JSON.parse(parent.budget) as BotTaskBudget : parent.budget;
          depth = budget.depth + 1;
          if (depth > BOT_TASK_MAX_DEPTH) throw new BotStateError("capacity_exceeded");
        }
        const row = await trx.insertInto("bot_tasks").values({
          task_id: newBotStateId("task"),
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          parent_task_id: input.parentTaskId ?? null,
          coordinator_bot_id: null,
          status: "queued",
          run_id: null,
          budget: JSON.stringify({ handoffs: 0, depth, toolActions: 0, microUsd: 0 } satisfies BotTaskBudget),
          running_since: null,
          blocked_reason: null,
          created_at: input.now,
          updated_at: input.now,
        }).returningAll().executeTakeFirstOrThrow().catch((error: unknown) => {
          if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
          throw error;
        });
        return fromRow(row);
      });
    },
    async transition(input: {
      ownerId: string;
      taskId: string;
      baseRevision: number;
      to: Exclude<BotTaskStatus, "queued">;
      blockedReason?: BotBlockedReason;
      runId?: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotTask> {
      if ((input.to === "blocked") !== (input.blockedReason !== undefined)) throw new BotStateError("invalid_transition");
      const row = await executor.updateTable("bot_tasks")
        .set((eb) => ({
          status: input.to,
          blocked_reason: input.blockedReason ?? null,
          run_id: input.runId ?? eb.ref("run_id"),
          active_ms: accruedActiveMs(input.now),
          running_since: input.to === "running" ? input.now : null,
          revision: sql<number>`revision + 1`,
          updated_at: input.now,
        }))
        .where("owner_id", "=", input.ownerId)
        .where("task_id", "=", input.taskId)
        .where("revision", "=", input.baseRevision)
        .where("status", "in", [...FROM[input.to]])
        .returningAll()
        .executeTakeFirst();
      if (row) return fromRow(row);
      const current = await get({ ownerId: input.ownerId, taskId: input.taskId }, executor);
      if (!current) throw new BotStateError("not_found");
      throw new BotStateError(current.revision !== input.baseRevision ? "revision_conflict" : "invalid_transition");
    },
    /**
     * Cancels a task and every unfinished descendant in one transaction, one
     * tree level at a time. Each level is updated (taking its row locks) before
     * its children are read in a new statement, so a child that a concurrent
     * create inserts under a locked parent is seen and cancelled too; a create
     * that runs after the parent is cancelled is refused. Returns the IDs.
     */
    async cancelTree(input: { ownerId: string; taskId: string; now: string }, executor: BotExecutor = db): Promise<string[]> {
      return withTransaction(executor, async (trx) => {
        const cancelled: string[] = [];
        let frontier = [input.taskId];
        for (let level = 0; frontier.length > 0; level += 1) {
          if (level > BOT_TASK_MAX_DEPTH) throw new BotStateError("capacity_exceeded");
          const updated = await trx.updateTable("bot_tasks")
            .set({
              status: "cancelled",
              blocked_reason: null,
              active_ms: accruedActiveMs(input.now),
              running_since: null,
              revision: sql<number>`revision + 1`,
              updated_at: input.now,
            })
            .where("owner_id", "=", input.ownerId).where("task_id", "in", frontier)
            .where("status", "not in", [...TERMINAL])
            .returning("task_id")
            .execute();
          cancelled.push(...updated.map((row) => row.task_id));
          const children = await trx.selectFrom("bot_tasks").select("task_id")
            .where("owner_id", "=", input.ownerId).where("parent_task_id", "in", frontier)
            .execute();
          frontier = children.map((row) => row.task_id);
        }
        return cancelled;
      });
    },
    /** Unfinished tasks of a bot in one chat, newest first. */
    async listOpen(input: { ownerId: string; botId: string; chatId: string }, executor: BotExecutor = db): Promise<BotTask[]> {
      const rows = await executor.selectFrom("bot_tasks").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .where("status", "not in", [...TERMINAL])
        .orderBy("created_at", "desc")
        .limit(MAX_OPEN_TASKS_LISTED)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type BotTasksRepository = ReturnType<typeof createBotTasksRepository>;
