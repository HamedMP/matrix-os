/**
 * Task comments. Adding or removing a comment and the task's comment count
 * change in one transaction; only the author edits or deletes a comment.
 * Comments do not bump the task revision, so a comment never turns someone's
 * in-progress description edit into a conflict.
 */
import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import type { ActorRef, TaskComment } from "@matrix-os/contracts/project-tasks";
import type { ProjectTaskDatabase, ProjectTaskDb, ProjectTaskTrx } from "./database.js";
import { ProjectTaskError } from "./errors.js";
import type { TaskScope } from "./repository.js";

type CommentRow = Selectable<ProjectTaskDatabase["project_task_comments"]>;

export function toTaskComment(row: CommentRow): TaskComment {
  return {
    id: row.id, taskId: row.task_id, author: row.author as ActorRef, body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at === null ? null : new Date(row.edited_at).toISOString(),
  };
}

export class ProjectTaskCommentRepository {
  constructor(private readonly db: ProjectTaskDb, private readonly now: () => Date = () => new Date()) {}

  async list(scope: TaskScope, taskId: string, cursor: string | undefined, limit: number): Promise<{ rows: CommentRow[]; nextCursor: string | null }> {
    let builder = this.db.selectFrom("project_task_comments").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("task_id", "=", taskId).where("deleted_at", "is", null);
    if (cursor) {
      const anchor = await this.db.selectFrom("project_task_comments").select(["created_at", "id"])
        .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("id", "=", cursor).executeTakeFirst();
      if (!anchor) throw new ProjectTaskError("invalid_request");
      builder = builder.where((eb) => eb.or([
        eb("created_at", ">", anchor.created_at),
        eb.and([eb("created_at", "=", anchor.created_at), eb("id", ">", anchor.id)]),
      ]));
    }
    const rows = await builder.orderBy("created_at", "asc").orderBy("id", "asc").limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return { rows: page, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }

  async add(scope: TaskScope, taskId: string, author: ActorRef, body: string): Promise<CommentRow> {
    return this.db.transaction().execute(async (trx) => {
      await this.requireTask(trx, scope, taskId);
      const at = this.now();
      const row = await trx.insertInto("project_task_comments").values({
        owner_id: scope.ownerId, id: `tcm_${randomUUID()}`, project_id: scope.projectId, task_id: taskId,
        author, body, created_at: at, edited_at: null, deleted_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("project_tasks").set({ comment_count: sql<number>`comment_count + 1`, updated_at: at })
        .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).execute();
      return row;
    });
  }

  async edit(scope: TaskScope, taskId: string, commentId: string, author: ActorRef, body: string): Promise<CommentRow> {
    return this.db.transaction().execute(async (trx) => {
      await this.requireTask(trx, scope, taskId);
      const row = await trx.updateTable("project_task_comments").set({ body, edited_at: this.now() })
        .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("id", "=", commentId)
        .where("author", "=", author).where("deleted_at", "is", null)
        .returningAll().executeTakeFirst();
      if (!row) throw await this.missing(trx, scope, taskId, commentId);
      return row;
    });
  }

  async remove(scope: TaskScope, taskId: string, commentId: string, author: ActorRef): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.requireTask(trx, scope, taskId);
      const at = this.now();
      const row = await trx.updateTable("project_task_comments").set({ deleted_at: at })
        .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("id", "=", commentId)
        .where("author", "=", author).where("deleted_at", "is", null)
        .returning("id").executeTakeFirst();
      if (!row) throw await this.missing(trx, scope, taskId, commentId);
      await trx.updateTable("project_tasks").set({ comment_count: sql<number>`greatest(comment_count - 1, 0)`, updated_at: at })
        .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).execute();
    });
  }

  private async requireTask(trx: ProjectTaskTrx, scope: TaskScope, taskId: string): Promise<void> {
    const task = await trx.selectFrom("project_tasks").select("id")
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("id", "=", taskId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!task) throw new ProjectTaskError("task_not_found");
  }

  /** Someone else's comment is forbidden; a missing or deleted one is not found. */
  private async missing(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, commentId: string): Promise<ProjectTaskError> {
    const other = await trx.selectFrom("project_task_comments").select("id")
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("id", "=", commentId)
      .where("deleted_at", "is", null).executeTakeFirst();
    return new ProjectTaskError(other ? "task_forbidden" : "comment_not_found");
  }
}
