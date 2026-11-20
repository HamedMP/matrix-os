import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql, type Selectable } from "kysely";
import type { BoardTask, BoardTaskNeed, BoardTaskState } from "@matrix-os/contracts/message-board";
import type { BoardTasksTable } from "./database.js";
import { boardFail } from "./errors.js";
import { parseActor, toIso, type BoardTrx } from "./rows.js";
import type { WriteContext } from "./service.js";
import type { TaskExtension } from "./task-hooks.js";

export type TaskRow = Selectable<BoardTasksTable>;

export const FINISHED_STATES: readonly BoardTaskState[] = ["completed", "failed", "canceled"];
const TITLE_MAX = 200;

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of the presented token's hash with the stored one. */
export function claimTokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const presented = Buffer.from(hashClaimToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

export function newClaimToken(): string {
  return randomBytes(32).toString("hex");
}

export function toBoardTask(row: TaskRow, needs: string[]): BoardTask {
  const holder = row.claim_holder ? parseActor(row.claim_holder) : null;
  return {
    state: row.state,
    createdBy: row.owner_actor,
    assignedProfile: row.assigned_profile,
    holder,
    leaseUntil: toIso(row.lease_until),
    epoch: row.claim_epoch,
    needs,
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    ...(row.blocked_kind ? { blockedKind: row.blocked_kind } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    updatedAt: toIso(row.updated_at)!,
  };
}

export async function needsFor(trx: BoardTrx, taskIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (taskIds.length === 0) return result;
  const rows = await trx.selectFrom("board_task_needs").select(["task_id", "needs_task_id"])
    .where("task_id", "in", taskIds).orderBy("task_id").orderBy("needs_task_id").execute();
  for (const row of rows) result.set(row.task_id, [...(result.get(row.task_id) ?? []), row.needs_task_id]);
  return result;
}

export function threadTitleOf(text: string, deleted: boolean): string {
  if (deleted) return "Deleted message";
  const line = text.split("\n").find((item) => item.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, TITLE_MAX) || "Untitled";
}

/** Thread reads see tasks through this extension. */
export const taskExtension: TaskExtension = {
  async load(trx, rootIds) {
    const rows = await trx.selectFrom("board_tasks").selectAll().where("root_id", "in", rootIds).execute();
    const needs = await needsFor(trx, rows.map((row) => row.root_id));
    return new Map(rows.map((row) => [row.root_id, toBoardTask(row, needs.get(row.root_id) ?? [])]));
  },
  async describeNeeds(trx, taskIds): Promise<BoardTaskNeed[]> {
    if (taskIds.length === 0) return [];
    const rows = await trx.selectFrom("board_tasks as t").innerJoin("board_messages as m", "m.id", "t.root_id")
      .select(["t.root_id", "t.state", "m.text", "m.deleted_at"]).where("t.root_id", "in", taskIds).execute();
    const byId = new Map(rows.map((row) => [row.root_id, row]));
    return taskIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ id, title: threadTitleOf(row.text, row.deleted_at != null), state: row.state }] : [];
    });
  },
  filterByState<Q>(builder: Q, state: BoardTaskState): Q {
    const where = (builder as unknown as { where(expression: unknown): Q }).where.bind(builder);
    return where(sql<boolean>`EXISTS (SELECT 1 FROM board_tasks t WHERE t.root_id = m.id AND t.state = ${state})`);
  },
};

/** Mirrors the state into the reserved `board.task` label on the root. */
export async function mirrorTaskLabel(ctx: WriteContext, rootId: string, state: BoardTaskState): Promise<void> {
  await ctx.trx.insertInto("board_labels").values({ owner_id: ctx.caller.ownerId, message_id: rootId, key: "board.task", value: state })
    .onConflict((oc) => oc.columns(["message_id", "key"]).doUpdateSet({ value: state })).execute();
}

export async function lockTask(ctx: WriteContext, rootId: string): Promise<TaskRow> {
  const row = await ctx.trx.selectFrom("board_tasks").selectAll().where("root_id", "=", rootId)
    .where("board_id", "=", ctx.board.id).forUpdate().executeTakeFirst();
  return row ?? boardFail("not_found");
}

/** `ready` when every prerequisite is completed, otherwise `waiting`. */
export async function readinessOf(ctx: WriteContext, needs: readonly string[]): Promise<"ready" | "waiting"> {
  if (needs.length === 0) return "ready";
  const rows = await ctx.trx.selectFrom("board_tasks").select("state").where("root_id", "in", needs).execute();
  return rows.length === needs.length && rows.every((row) => row.state === "completed") ? "ready" : "waiting";
}

/**
 * Prerequisites must be distinct tasks on this board, never the task itself,
 * and never a task that (transitively) needs it.
 */
export async function validateNeeds(ctx: WriteContext, taskId: string | null, needs: readonly string[]): Promise<void> {
  if (new Set(needs).size !== needs.length || (taskId && needs.includes(taskId))) boardFail("invalid_needs");
  if (needs.length === 0) return;
  const rows = await ctx.trx.selectFrom("board_tasks").select("root_id").where("root_id", "in", needs)
    .where("board_id", "=", ctx.board.id).execute();
  if (rows.length !== needs.length) boardFail("invalid_needs");
  if (!taskId) return;
  const reachesTask = await sql<{ found: number }>`
    WITH RECURSIVE upstream(id) AS (
      SELECT needs_task_id FROM board_task_needs WHERE task_id IN (${sql.join(needs)})
      UNION SELECT n.needs_task_id FROM board_task_needs n JOIN upstream u ON n.task_id = u.id
    ) SELECT 1 AS found FROM upstream WHERE id = ${taskId} LIMIT 1`.execute(ctx.trx);
  if (reachesTask.rows.length > 0) boardFail("invalid_needs");
}

export async function writeNeeds(ctx: WriteContext, taskId: string, needs: readonly string[]): Promise<void> {
  await ctx.trx.deleteFrom("board_task_needs").where("task_id", "=", taskId).execute();
  if (needs.length === 0) return;
  await ctx.trx.insertInto("board_task_needs")
    .values(needs.map((needsTaskId) => ({ owner_id: ctx.caller.ownerId, task_id: taskId, needs_task_id: needsTaskId }))).execute();
}

/** Orders plan items so prerequisites come first; refuses cycles and unknown keys. */
export function orderPlan<T extends { key: string; needs?: string[] }>(items: readonly T[], isExistingTask: (ref: string) => boolean): T[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  if (byKey.size !== items.length) boardFail("invalid_needs");
  const ordered: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (item: T) => {
    const mark = state.get(item.key);
    if (mark === "done") return;
    if (mark === "visiting") boardFail("invalid_needs");
    state.set(item.key, "visiting");
    for (const ref of item.needs ?? []) {
      const dependency = byKey.get(ref);
      if (dependency) visit(dependency);
      else if (!isExistingTask(ref)) boardFail("invalid_needs");
    }
    state.set(item.key, "done");
    ordered.push(item);
  };
  for (const item of items) visit(item);
  return ordered;
}
