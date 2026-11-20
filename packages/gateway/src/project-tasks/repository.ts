/**
 * Kysely store for project tasks. Every mutation writes the task row and its
 * activity row in one transaction; content edits carry `WHERE revision = base`
 * in the UPDATE itself, and moves are one targeted last-writer-wins UPDATE.
 */
import { sql, type Selectable } from "kysely";
import {
  TASK_LIMITS, TaskRankError, formatTaskKey, rankBetween,
  type ActorRef, type ProjectTask, type TaskActivity, type TaskActivityKind, type TaskPriority, type TaskStatus,
} from "@matrix-os/contracts/project-tasks";
import type { BoardAutomationColumn, ProjectTaskDatabase, ProjectTaskDb, ProjectTaskTrx } from "./database.js";
import { ProjectTaskError } from "./errors.js";

export type TaskRow = Selectable<ProjectTaskDatabase["project_tasks"]>;
export type BoardRow = Selectable<ProjectTaskDatabase["project_board_settings"]>;
type ActivityRow = Selectable<ProjectTaskDatabase["project_task_activity"]>;

export const DEFAULT_AUTOMATION: BoardAutomationColumn = { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true };

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled",
};
const PRIORITY_LABEL: Record<TaskPriority, string> = { none: "No priority", low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const MAX_PARENT_DEPTH = 100;

export interface TaskScope {
  ownerId: string;
  projectId: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: ActorRef | null;
  labels?: readonly string[];
  parentTaskId?: string | null;
  dueAt?: string | null;
  afterTaskId?: string;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: ActorRef | null;
  labels?: readonly string[];
  dueAt?: string | null;
  parentTaskId?: string | null;
  blockedBy?: readonly string[];
}

export interface MoveInput {
  status: TaskStatus;
  afterTaskId?: string;
  beforeTaskId?: string;
}

export interface ListQuery {
  status?: TaskStatus;
  assignee?: ActorRef | "unassigned";
  label?: string;
  q?: string;
  cursor?: string;
  limit: number;
  includeArchived: boolean;
}

/** Imported legacy record, already mapped to board values. */
export interface ImportedTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  parentTaskId: string | null;
  dueAt: string | null;
  worktreeId: string | null;
  legacySessionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  rank: string;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

export interface TaskExtras {
  blockedBy?: readonly string[];
}

export function toProjectTask(row: TaskRow, keyPrefix: string, extras: TaskExtras = {}): ProjectTask {
  return {
    id: row.id,
    projectId: row.project_id,
    number: Number(row.number),
    key: formatTaskKey(keyPrefix, Number(row.number)),
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    rank: row.rank,
    assignee: row.assignee as ActorRef | null,
    labels: row.labels,
    parentTaskId: row.parent_task_id,
    blockedBy: [...(extras.blockedBy ?? [])],
    dueAt: isoOrNull(row.due_at),
    worktreeId: row.worktree_id,
    branch: row.branch,
    pullRequest: null,
    externalLink: null,
    sessions: [],
    commentCount: Number(row.comment_count),
    createdBy: row.created_by as ActorRef,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
    revision: Number(row.revision),
  };
}

export function toTaskActivity(row: ActivityRow): TaskActivity {
  return {
    seq: Number(row.seq), taskId: row.task_id, actor: row.actor as ActorRef, kind: row.kind as TaskActivityKind,
    summary: row.summary, at: iso(row.created_at),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export class ProjectTaskRepository {
  constructor(readonly db: ProjectTaskDb, private readonly now: () => Date = () => new Date()) {}

  /** The project's board row, created with defaults on first use. */
  async ensureBoard(scope: TaskScope, defaultKey: string): Promise<BoardRow> {
    const at = this.now();
    await this.db.insertInto("project_board_settings").values({
      owner_id: scope.ownerId, project_id: scope.projectId, task_key: defaultKey, next_number: 1,
      automation: JSON.stringify(DEFAULT_AUTOMATION), legacy_import_at: null, created_at: at, updated_at: at,
    }).onConflict((conflict) => conflict.columns(["owner_id", "project_id"]).doNothing()).execute();
    return this.db.selectFrom("project_board_settings").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).executeTakeFirstOrThrow();
  }

  async updateBoard(scope: TaskScope, patch: { taskKey?: string; automation?: Partial<BoardAutomationColumn> }): Promise<BoardRow> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("project_board_settings").selectAll()
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).forUpdate().executeTakeFirst();
      if (!current) throw new ProjectTaskError("project_not_found");
      const automation = { ...DEFAULT_AUTOMATION, ...current.automation, ...patch.automation };
      return trx.updateTable("project_board_settings")
        .set({ task_key: patch.taskKey ?? current.task_key, automation: JSON.stringify(automation), updated_at: this.now() })
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .returningAll().executeTakeFirstOrThrow();
    });
  }

  async listTasks(scope: TaskScope, query: ListQuery): Promise<{ rows: TaskRow[]; nextCursor: string | null }> {
    let builder = this.db.selectFrom("project_tasks").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).where("deleted_at", "is", null);
    if (!query.includeArchived) builder = builder.where("archived_at", "is", null);
    if (query.status) builder = builder.where("status", "=", query.status);
    if (query.assignee === "unassigned") builder = builder.where("assignee", "is", null);
    else if (query.assignee) builder = builder.where("assignee", "=", query.assignee);
    if (query.label) builder = builder.where(sql<boolean>`labels @> ARRAY[${query.label}]::text[]`);
    const search = query.q?.trim();
    if (search) {
      const keyNumber = /^(?:[A-Za-z][A-Za-z0-9]{1,9}-)?(\d{1,12})$/.exec(search)?.[1];
      const pattern = `%${escapeLike(search)}%`;
      builder = builder.where((eb) => eb.or([
        eb("title", "ilike", sql<string>`${pattern} ESCAPE '\\'`),
        ...(keyNumber ? [eb("number", "=", Number(keyNumber))] : []),
      ]));
    }
    const after = query.cursor ? /^n(\d{1,15})$/.exec(query.cursor)?.[1] : undefined;
    if (query.cursor && after === undefined) throw new ProjectTaskError("invalid_request");
    if (after !== undefined) builder = builder.where("number", ">", Number(after));
    const rows = await builder.orderBy("number", "asc").limit(query.limit + 1).execute();
    const page = rows.slice(0, query.limit);
    return { rows: page, nextCursor: rows.length > query.limit ? `n${Number(page.at(-1)!.number)}` : null };
  }

  async getTask(scope: TaskScope, taskId: string): Promise<TaskRow | undefined> {
    return this.db.selectFrom("project_tasks").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("id", "=", taskId).where("deleted_at", "is", null).executeTakeFirst();
  }

  /** Live blockers of each task, keyed by task id. */
  async blockedByFor(scope: TaskScope, taskIds: readonly string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    if (taskIds.length === 0) return result;
    const rows = await this.db.selectFrom("project_task_relations as r")
      .innerJoin("project_tasks as b", (join) => join.onRef("b.owner_id", "=", "r.owner_id").onRef("b.id", "=", "r.blocked_by_task_id"))
      .select(["r.task_id", "r.blocked_by_task_id"])
      .where("r.owner_id", "=", scope.ownerId).where("b.project_id", "=", scope.projectId)
      .where("b.deleted_at", "is", null).where("r.task_id", "in", [...taskIds])
      .orderBy("r.created_at", "asc").execute();
    for (const row of rows) (result[row.task_id] ??= []).push(row.blocked_by_task_id);
    return result;
  }

  async createTask(
    scope: TaskScope,
    input: CreateTaskInput & { id: string; clientRequestId: string; payloadHash: string },
    actor: ActorRef,
  ): Promise<{ row: TaskRow; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const at = this.now();
      const reserved = await trx.insertInto("project_task_operations").values({
        owner_id: scope.ownerId, client_request_id: input.clientRequestId, project_id: scope.projectId,
        payload_hash: input.payloadHash, task_id: null, created_at: at,
      }).onConflict((conflict) => conflict.columns(["owner_id", "client_request_id"]).doNothing())
        .returning("client_request_id").executeTakeFirst();
      if (!reserved) {
        const existing = await trx.selectFrom("project_task_operations").selectAll()
          .where("owner_id", "=", scope.ownerId).where("client_request_id", "=", input.clientRequestId).executeTakeFirstOrThrow();
        if (existing.payload_hash !== input.payloadHash || existing.project_id !== scope.projectId || !existing.task_id) {
          throw new ProjectTaskError("invalid_request");
        }
        const row = await trx.selectFrom("project_tasks").selectAll()
          .where("owner_id", "=", scope.ownerId).where("id", "=", existing.task_id).executeTakeFirst();
        if (!row || row.deleted_at !== null) throw new ProjectTaskError("task_not_found");
        return { row, created: false };
      }
      const active = await trx.selectFrom("project_tasks").select(sql<string>`count(*)`.as("count"))
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("deleted_at", "is", null).where("archived_at", "is", null).executeTakeFirstOrThrow();
      if (Number(active.count) >= TASK_LIMITS.tasksPerProject) throw new ProjectTaskError("task_limit_reached");
      if (input.parentTaskId) await this.assertParent(trx, scope, input.id, input.parentTaskId);
      const status = input.status ?? "backlog";
      const rank = await this.rankForInsert(trx, scope, status, input.afterTaskId);
      const number = await this.allocateNumber(trx, scope);
      const row = await trx.insertInto("project_tasks").values({
        owner_id: scope.ownerId, id: input.id, project_id: scope.projectId, number, title: input.title,
        description: input.description ?? "", status, priority: input.priority ?? "none", rank,
        assignee: input.assignee ?? null, labels: [...(input.labels ?? [])], parent_task_id: input.parentTaskId ?? null,
        due_at: input.dueAt ?? null, worktree_id: null, branch: null, pr_number: null, legacy_session_id: null,
        comment_count: 0, created_by: actor, created_at: at, updated_at: at, revision: 1, archived_at: null, deleted_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await this.log(trx, scope, input.id, actor, "created", "Created the task", at);
      await trx.updateTable("project_task_operations").set({ task_id: input.id })
        .where("owner_id", "=", scope.ownerId).where("client_request_id", "=", input.clientRequestId).execute();
      return { row, created: true };
    });
  }

  async updateTask(scope: TaskScope, taskId: string, baseRevision: number, patch: TaskPatch, actor: ActorRef): Promise<TaskRow> {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("project_tasks").selectAll()
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("id", "=", taskId).where("deleted_at", "is", null).executeTakeFirst();
      if (!before) throw new ProjectTaskError("task_not_found");
      if (Number(before.revision) !== baseRevision) throw new RevisionConflict(before);
      if (patch.parentTaskId) await this.assertParent(trx, scope, taskId, patch.parentTaskId);
      const at = this.now();
      const blockersChanged = patch.blockedBy !== undefined && await this.replaceBlockers(trx, scope, taskId, patch.blockedBy, at);
      const row = await trx.updateTable("project_tasks").set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
        ...(patch.dueAt !== undefined ? { due_at: patch.dueAt } : {}),
        ...(patch.parentTaskId !== undefined ? { parent_task_id: patch.parentTaskId } : {}),
        updated_at: at,
        revision: sql<number>`revision + 1`,
      }).where("owner_id", "=", scope.ownerId).where("id", "=", taskId).where("deleted_at", "is", null)
        // The guard lives in the write itself, so a concurrent edit cannot slip in under READ COMMITTED.
        .where("revision", "=", baseRevision)
        .returningAll().executeTakeFirst();
      if (!row) {
        const current = await trx.selectFrom("project_tasks").selectAll()
          .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).where("deleted_at", "is", null).executeTakeFirst();
        if (!current) throw new ProjectTaskError("task_not_found");
        throw new RevisionConflict(current);
      }
      for (const [kind, summary] of describePatch(before, patch)) await this.log(trx, scope, taskId, actor, kind, summary, at);
      if (blockersChanged) {
        await this.log(trx, scope, taskId, actor, "relations_changed", patch.blockedBy!.length ? "Changed what blocks this task" : "Removed all blockers", at);
      }
      return row;
    });
  }

  async moveTask(scope: TaskScope, taskId: string, input: MoveInput, actor: ActorRef): Promise<{ row: TaskRow; previousStatus: TaskStatus }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("project_tasks").select(["status"])
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("id", "=", taskId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!current) throw new ProjectTaskError("task_not_found");
      const rank = await this.rankBetweenNeighbours(trx, scope, input.status, taskId, input.afterTaskId, input.beforeTaskId);
      const at = this.now();
      const row = await trx.updateTable("project_tasks")
        .set({ status: input.status, rank, updated_at: at, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).where("deleted_at", "is", null)
        .returningAll().executeTakeFirstOrThrow();
      const previousStatus = current.status as TaskStatus;
      if (previousStatus !== input.status) {
        await this.log(trx, scope, taskId, actor, "moved", `${TASK_STATUS_LABEL[previousStatus]} → ${TASK_STATUS_LABEL[input.status]}`, at);
      }
      return { row, previousStatus };
    });
  }

  async setArchived(scope: TaskScope, taskId: string, archived: boolean, actor: ActorRef): Promise<{ row: TaskRow; changed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const at = this.now();
      const row = await trx.updateTable("project_tasks")
        .set({ archived_at: archived ? at : null, updated_at: at, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("id", "=", taskId).where("deleted_at", "is", null)
        .where("archived_at", archived ? "is" : "is not", null)
        .returningAll().executeTakeFirst();
      if (!row) {
        const current = await trx.selectFrom("project_tasks").selectAll()
          .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
          .where("id", "=", taskId).where("deleted_at", "is", null).executeTakeFirst();
        if (!current) throw new ProjectTaskError("task_not_found");
        return { row: current, changed: false };
      }
      await this.log(trx, scope, taskId, actor, archived ? "archived" : "unarchived", archived ? "Archived the task" : "Restored the task", at);
      return { row, changed: true };
    });
  }

  /** Soft delete; a repeat delete is not found. Subtasks lose their parent in the same transaction. */
  async deleteTask(scope: TaskScope, taskId: string, actor: ActorRef): Promise<TaskRow> {
    return this.db.transaction().execute(async (trx) => {
      const at = this.now();
      const row = await trx.updateTable("project_tasks")
        .set({ deleted_at: at, updated_at: at, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("id", "=", taskId).where("deleted_at", "is", null)
        .returningAll().executeTakeFirst();
      if (!row) throw new ProjectTaskError("task_not_found");
      await trx.updateTable("project_tasks")
        .set({ parent_task_id: null, updated_at: at, revision: sql<number>`revision + 1` })
        .where("owner_id", "=", scope.ownerId).where("parent_task_id", "=", taskId).where("deleted_at", "is", null).execute();
      await trx.deleteFrom("project_task_relations").where("owner_id", "=", scope.ownerId)
        .where((eb) => eb.or([eb("task_id", "=", taskId), eb("blocked_by_task_id", "=", taskId)])).execute();
      await this.log(trx, scope, taskId, actor, "deleted", "Deleted the task", at);
      return row;
    });
  }

  async listActivity(scope: TaskScope, taskId: string, after: number, limit: number): Promise<{ rows: ActivityRow[]; nextCursor: string | null }> {
    const rows = await this.db.selectFrom("project_task_activity").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).where("task_id", "=", taskId)
      .where("seq", ">", after).orderBy("seq", "asc").limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return { rows: page, nextCursor: rows.length > limit ? String(Number(page.at(-1)!.seq)) : null };
  }

  /**
   * One-time import of the legacy JSON tasks. The settings row is locked so
   * concurrent first requests import once; rows that already exist are kept.
   */
  async importLegacy(scope: TaskScope, tasks: readonly ImportedTask[]): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const board = await trx.selectFrom("project_board_settings").select(["legacy_import_at"])
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).forUpdate().executeTakeFirst();
      if (!board) throw new ProjectTaskError("project_not_found");
      if (board.legacy_import_at !== null) return 0;
      const ordered = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const known = new Set(ordered.map((task) => task.id));
      let imported = 0;
      for (const task of ordered.slice(0, TASK_LIMITS.tasksPerProject)) {
        const number = await this.allocateNumber(trx, scope);
        const inserted = await trx.insertInto("project_tasks").values({
          owner_id: scope.ownerId, id: task.id, project_id: scope.projectId, number, title: task.title,
          description: task.description, status: task.status, priority: task.priority, rank: task.rank, assignee: null,
          labels: task.labels, parent_task_id: task.parentTaskId && known.has(task.parentTaskId) && task.parentTaskId !== task.id ? task.parentTaskId : null,
          due_at: task.dueAt, worktree_id: task.worktreeId, branch: null, pr_number: null, legacy_session_id: task.legacySessionId,
          comment_count: 0, created_by: "system:import", created_at: task.createdAt, updated_at: task.updatedAt, revision: 1,
          archived_at: task.archivedAt, deleted_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_id", "id"]).doNothing()).returning("id").executeTakeFirst();
        if (!inserted) continue;
        imported += 1;
        await this.log(trx, scope, task.id, "system:import", "imported", "Imported from the previous task list", this.now());
      }
      await trx.updateTable("project_board_settings").set({ legacy_import_at: this.now(), updated_at: this.now() })
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId).execute();
      return imported;
    });
  }

  // -------------------------------------------------------------------------

  private async log(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, actor: ActorRef, kind: TaskActivityKind, summary: string, at: Date): Promise<void> {
    await trx.insertInto("project_task_activity").values({
      owner_id: scope.ownerId, project_id: scope.projectId, task_id: taskId, actor, kind, summary: clip(summary, 400), created_at: at,
    }).execute();
  }

  private async allocateNumber(trx: ProjectTaskTrx, scope: TaskScope): Promise<number> {
    const board = await trx.updateTable("project_board_settings").set({ next_number: sql<number>`next_number + 1` })
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .returning("next_number").executeTakeFirst();
    if (!board) throw new ProjectTaskError("project_not_found");
    return Number(board.next_number) - 1;
  }

  private columnRanks(trx: ProjectTaskTrx, scope: TaskScope, status: TaskStatus, excludeId: string | null) {
    let builder = trx.selectFrom("project_tasks").select(["id", "rank"])
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("status", "=", status).where("deleted_at", "is", null);
    if (excludeId) builder = builder.where("id", "<>", excludeId);
    return builder;
  }

  private async rankForInsert(trx: ProjectTaskTrx, scope: TaskScope, status: TaskStatus, afterTaskId?: string): Promise<string> {
    return this.rankBetweenNeighbours(trx, scope, status, null, afterTaskId, undefined);
  }

  /**
   * A rank between the named neighbours when they are still in the target
   * column; stale neighbours (moved or deleted by someone else) fall back to
   * the nearest valid position rather than failing the move.
   */
  private async rankBetweenNeighbours(
    trx: ProjectTaskTrx, scope: TaskScope, status: TaskStatus, movingId: string | null, afterTaskId?: string, beforeTaskId?: string,
  ): Promise<string> {
    const column = this.columnRanks(trx, scope, status, movingId);
    const neighbour = async (id: string | undefined) => (id
      ? (await column.where("id", "=", id).executeTakeFirst())?.rank ?? null
      : null);
    const after = await neighbour(afterTaskId);
    let before = await neighbour(beforeTaskId);
    if (after !== null && (before === null || before <= after)) {
      before = (await column.where("rank", ">", after).orderBy("rank", "asc").limit(1).executeTakeFirst())?.rank ?? null;
    }
    if (after === null && before === null) {
      // No usable neighbours: the top of the column.
      before = (await column.orderBy("rank", "asc").limit(1).executeTakeFirst())?.rank ?? null;
    }
    try {
      return rankBetween(after, before);
    } catch (error: unknown) {
      if (error instanceof TaskRankError) {
        console.warn("[project-tasks] rank fallback", error.code);
        throw new ProjectTaskError("invalid_request");
      }
      throw error;
    }
  }

  /** Replace a task's blockers; each must be another live task of this project. Returns whether the set changed. */
  private async replaceBlockers(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, blockedBy: readonly string[], at: Date): Promise<boolean> {
    const wanted = [...new Set(blockedBy)];
    if (wanted.length > TASK_LIMITS.relations || wanted.includes(taskId)) throw new ProjectTaskError("task_relation_invalid");
    if (wanted.length > 0) {
      const live = await trx.selectFrom("project_tasks").select("id")
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("deleted_at", "is", null).where("id", "in", wanted).execute();
      if (live.length !== wanted.length) throw new ProjectTaskError("task_relation_invalid");
    }
    const current = (await trx.selectFrom("project_task_relations").select("blocked_by_task_id")
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).execute()).map((row) => row.blocked_by_task_id);
    if (current.length === wanted.length && current.every((id) => wanted.includes(id))) return false;
    await trx.deleteFrom("project_task_relations").where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).execute();
    if (wanted.length > 0) {
      await trx.insertInto("project_task_relations")
        .values(wanted.map((id) => ({ owner_id: scope.ownerId, task_id: taskId, blocked_by_task_id: id, created_at: at })))
        .execute();
    }
    return true;
  }

  /** A parent must be another live task of this project, and the chain must not loop back. */
  private async assertParent(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, parentId: string): Promise<void> {
    if (parentId === taskId) throw new ProjectTaskError("task_relation_invalid");
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth += 1) {
      if (depth >= MAX_PARENT_DEPTH || cursor === taskId) throw new ProjectTaskError("task_relation_invalid");
      const parentRow: { parent_task_id: string | null } | undefined = await trx.selectFrom("project_tasks").select(["parent_task_id"])
        .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
        .where("id", "=", cursor).where("deleted_at", "is", null).executeTakeFirst();
      if (!parentRow) throw new ProjectTaskError("task_relation_invalid");
      cursor = parentRow.parent_task_id;
    }
    const children = await trx.selectFrom("project_tasks").select(sql<string>`count(*)`.as("count"))
      .where("owner_id", "=", scope.ownerId).where("parent_task_id", "=", parentId).where("deleted_at", "is", null)
      .where("id", "<>", taskId).executeTakeFirstOrThrow();
    if (Number(children.count) >= TASK_LIMITS.subtasks) throw new ProjectTaskError("task_limit_reached");
  }
}

/** Raised inside a transaction when `baseRevision` is stale; carries the current row. */
export class RevisionConflict extends Error {
  constructor(readonly current: TaskRow) {
    super("task_revision_conflict");
    this.name = "RevisionConflict";
  }
}

function describePatch(before: TaskRow, patch: TaskPatch): Array<[TaskActivityKind, string]> {
  const changes: Array<[TaskActivityKind, string]> = [];
  if (patch.title !== undefined && patch.title !== before.title) changes.push(["renamed", `Renamed to “${clip(patch.title, 200)}”`]);
  if (patch.description !== undefined && patch.description !== before.description) changes.push(["described", "Edited the description"]);
  if (patch.priority !== undefined && patch.priority !== before.priority) changes.push(["priority_changed", `Priority ${PRIORITY_LABEL[patch.priority]}`]);
  if (patch.assignee !== undefined && patch.assignee !== before.assignee) {
    changes.push(["assigned", patch.assignee ? "Changed the assignee" : "Unassigned the task"]);
  }
  if (patch.labels !== undefined && patch.labels.join("\u0000") !== before.labels.join("\u0000")) {
    changes.push(["labels_changed", patch.labels.length ? `Labels: ${clip(patch.labels.join(", "), 300)}` : "Removed all labels"]);
  }
  if (patch.dueAt !== undefined && patch.dueAt !== isoOrNull(before.due_at)) {
    changes.push(["due_changed", patch.dueAt ? "Changed the due date" : "Removed the due date"]);
  }
  if (patch.parentTaskId !== undefined && patch.parentTaskId !== before.parent_task_id) {
    changes.push(["parent_changed", patch.parentTaskId ? "Changed the parent task" : "Removed the parent task"]);
  }
  return changes;
}
