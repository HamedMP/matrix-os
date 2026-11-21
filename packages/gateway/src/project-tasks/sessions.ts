/**
 * Store for task sessions, the task's worktree record and its pull request
 * summary (spec 2699 sections 3 and 4). Each write locks the task row, writes
 * the change and its activity row, and bumps the revision in one transaction.
 * A session belongs to one task: `UNIQUE (owner_id, session_ref)`.
 */
import { sql, type Selectable } from "kysely";
import {
  TASK_LIMITS, rankBetween,
  type ActorRef, type TaskActivityKind, type TaskPullRequest, type TaskSession, type TaskStatus,
} from "@matrix-os/contracts/project-tasks";
import type { BoardAutomationColumn, ProjectTaskDatabase, ProjectTaskDb, ProjectTaskTrx } from "./database.js";
import { ProjectTaskError } from "./errors.js";
import { TASK_STATUS_LABEL, pullRequestFromRow, type TaskRow, type TaskScope } from "./repository.js";

export type SessionRow = Selectable<ProjectTaskDatabase["project_task_sessions"]>;
export const AUTOMATION_ACTOR: ActorRef = "system:automation";

export interface SessionLinkInput {
  ref: string;
  kind: TaskSession["kind"];
  title: string;
  harness?: string;
  startRequestId?: string;
  /**
   * Links of this task the caller found unavailable (chat gone or archived, tab
   * closed). They do not count toward the session limit: when the task is full,
   * they are removed in the same transaction to make room.
   */
  prune?: readonly string[];
}

/** Statuses a PR transition may move a task out of; automation only moves forward. */
const OPENED_FROM: readonly TaskStatus[] = ["in_progress"];
const MERGED_FROM: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review"];

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export class ProjectTaskSessionRepository {
  constructor(private readonly db: ProjectTaskDb, private readonly now: () => Date = () => new Date()) {}

  /** Session links of each task, main first, keyed by task id. */
  async listForTasks(scope: TaskScope, taskIds: readonly string[]): Promise<Record<string, SessionRow[]>> {
    const result: Record<string, SessionRow[]> = {};
    if (taskIds.length === 0) return result;
    const rows = await this.db.selectFrom("project_task_sessions").selectAll()
      .where("owner_id", "=", scope.ownerId).where("task_id", "in", [...taskIds])
      .orderBy("task_id").orderBy(sql`role = 'main'`, "desc").orderBy("created_at", "asc").orderBy("session_ref", "asc")
      .limit(taskIds.length * TASK_LIMITS.sessions).execute();
    for (const row of rows) (result[row.task_id] ??= []).push(row);
    return result;
  }

  async findByStartRequest(scope: TaskScope, taskId: string, startRequestId: string): Promise<SessionRow | undefined> {
    return this.db.selectFrom("project_task_sessions").selectAll()
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId)
      .where("start_request_id", "=", startRequestId).executeTakeFirst();
  }

  /** Which of `refs` already belong to some task of this owner. */
  async boundRefs(scope: TaskScope, refs: readonly string[]): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const rows = await this.db.selectFrom("project_task_sessions").select("session_ref")
      .where("owner_id", "=", scope.ownerId).where("session_ref", "in", [...refs]).execute();
    return new Set(rows.map((row) => row.session_ref));
  }

  async count(scope: TaskScope, taskId: string): Promise<number> {
    const row = await this.db.selectFrom("project_task_sessions").select(sql<string>`count(*)`.as("count"))
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Link a session to a task. Re-linking the same session to the same task is a
   * no-op; a session owned by another task, or a task at the session limit, is refused.
   */
  async link(scope: TaskScope, taskId: string, input: SessionLinkInput, actor: ActorRef, kind: TaskActivityKind): Promise<{ row: SessionRow; created: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockTask(trx, scope, taskId);
      const existing = await trx.selectFrom("project_task_sessions").selectAll()
        .where("owner_id", "=", scope.ownerId).where("session_ref", "=", input.ref).executeTakeFirst();
      if (existing) {
        if (existing.task_id !== taskId) throw new ProjectTaskError("task_session_taken");
        return { row: existing, created: false };
      }
      const at = this.now();
      const countLinks = async () => Number((await trx.selectFrom("project_task_sessions").select(sql<string>`count(*)`.as("count"))
        .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).executeTakeFirstOrThrow()).count);
      let count = await countLinks();
      const prune = (input.prune ?? []).filter((ref) => ref !== input.ref).slice(0, TASK_LIMITS.sessions);
      if (count >= TASK_LIMITS.sessions && prune.length > 0) {
        await this.pruneInside(trx, scope, taskId, prune, at);
        count = await countLinks();
      }
      if (count >= TASK_LIMITS.sessions) throw new ProjectTaskError("task_limit_reached");
      const row = await trx.insertInto("project_task_sessions").values({
        owner_id: scope.ownerId, task_id: taskId, session_ref: input.ref, kind: input.kind, title: clip(input.title, 200),
        role: count === 0 ? "main" : "extra", harness: input.harness ?? null,
        start_request_id: input.startRequestId ?? null, created_by: actor, created_at: at,
      }).returningAll().executeTakeFirstOrThrow();
      await this.touch(trx, scope, taskId, at);
      await this.log(trx, scope, taskId, actor, kind,
        `${kind === "session_started" ? "Started" : "Attached"} ${input.kind === "chat" ? "a chat" : "a terminal"}: ${clip(input.title, 200)}`, at);
      return { row, created: true };
    });
  }

  /** Remove a link; the session keeps running. The oldest extra session becomes main when main leaves. */
  async unlink(scope: TaskScope, taskId: string, ref: string, actor: ActorRef): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lockTask(trx, scope, taskId);
      const removed = await trx.deleteFrom("project_task_sessions")
        .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("session_ref", "=", ref)
        .returningAll().executeTakeFirst();
      if (!removed) throw new ProjectTaskError("task_session_not_found");
      if (removed.role === "main") await this.promoteMain(trx, scope, taskId);
      const at = this.now();
      await this.touch(trx, scope, taskId, at);
      await this.log(trx, scope, taskId, actor, "session_detached", `Detached ${removed.kind === "chat" ? "a chat" : "a terminal"}: ${removed.title}`, at);
    });
  }

  /** Record the task's worktree and branch once; a task that already has one keeps it. */
  async recordWorktree(scope: TaskScope, taskId: string, worktreeId: string, branch: string): Promise<TaskRow> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockTask(trx, scope, taskId);
      if (current.worktree_id !== null) return current;
      return trx.updateTable("project_tasks")
        .set({ worktree_id: worktreeId, branch, updated_at: this.now(), revision: sql<number>`revision + 1` })
        .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).where("deleted_at", "is", null)
        .returningAll().executeTakeFirstOrThrow();
    });
  }

  /** Automation move: only from one of `from`, to the top of `to`. Returns null when the task was elsewhere. */
  async advance(scope: TaskScope, taskId: string, from: readonly TaskStatus[], to: TaskStatus): Promise<TaskRow | null> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockTask(trx, scope, taskId);
      return from.includes(current.status as TaskStatus) ? this.moveInside(trx, scope, current, to) : null;
    });
  }

  /**
   * Store a refreshed pull request summary. Automation fires on a state change
   * only, so a person who moves the card back is not overruled by later refreshes.
   */
  async storePullRequest(
    scope: TaskScope, taskId: string, pullRequest: TaskPullRequest | null, automation: BoardAutomationColumn,
  ): Promise<{ row: TaskRow; changed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const current = await this.lockTask(trx, scope, taskId);
      const before = pullRequestFromRow(current);
      const at = this.now();
      if (JSON.stringify(before) === JSON.stringify(pullRequest)) {
        const row = await trx.updateTable("project_tasks").set({ pr_refreshed_at: at })
          .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).returningAll().executeTakeFirstOrThrow();
        return { row, changed: false };
      }
      let row = await trx.updateTable("project_tasks").set({
        pr_number: pullRequest?.number ?? null, pr_state: pullRequest?.state ?? null, pr_checks: pullRequest?.checks ?? null,
        pr_review: pullRequest?.review ?? null, pr_url: pullRequest?.url ?? null, pr_refreshed_at: at,
        updated_at: at, revision: sql<number>`revision + 1`,
      }).where("owner_id", "=", scope.ownerId).where("id", "=", taskId).returningAll().executeTakeFirstOrThrow();
      const wasLive = before?.state === "open" || before?.state === "draft";
      const isLive = pullRequest?.state === "open" || pullRequest?.state === "draft";
      const samePullRequest = before?.number === pullRequest?.number;
      if (pullRequest && isLive && (!samePullRequest || !wasLive)) {
        await this.log(trx, scope, taskId, AUTOMATION_ACTOR, "pr_opened", `Pull request #${pullRequest.number} opened`, at);
      }
      // A draft is not ready for review: the card moves when the PR is (or becomes) ready.
      if (pullRequest?.state === "open" && (!samePullRequest || before?.state !== "open")
        && automation.prOpenMovesToReview && OPENED_FROM.includes(row.status as TaskStatus)) {
        row = await this.moveInside(trx, scope, row, "in_review");
      }
      if (pullRequest?.state === "merged" && (!samePullRequest || before?.state !== "merged")) {
        await this.log(trx, scope, taskId, AUTOMATION_ACTOR, "pr_merged", `Pull request #${pullRequest.number} merged`, at);
        if (automation.prMergeMovesToDone && MERGED_FROM.includes(row.status as TaskStatus)) {
          row = await this.moveInside(trx, scope, row, "done");
        }
      }
      return { row, changed: true };
    });
  }

  // -------------------------------------------------------------------------

  /** Remove unavailable links (the caller holds the task lock), log each, and keep one main. */
  private async pruneInside(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, refs: readonly string[], at: Date): Promise<void> {
    if (refs.length === 0) return;
    const removed = await trx.deleteFrom("project_task_sessions")
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("session_ref", "in", [...refs])
      .returningAll().execute();
    if (removed.length === 0) return;
    if (removed.some((row) => row.role === "main")) await this.promoteMain(trx, scope, taskId);
    for (const row of removed) {
      await this.log(trx, scope, taskId, AUTOMATION_ACTOR, "session_detached",
        `Detached ${row.kind === "chat" ? "a deleted chat" : "a closed terminal"}: ${row.title}`, at);
    }
  }

  /** The oldest remaining link becomes main. */
  private async promoteMain(trx: ProjectTaskTrx, scope: TaskScope, taskId: string): Promise<void> {
    const next = await trx.selectFrom("project_task_sessions").select("session_ref")
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId)
      .orderBy("created_at", "asc").orderBy("session_ref", "asc").limit(1).executeTakeFirst();
    if (!next) return;
    await trx.updateTable("project_task_sessions").set({ role: "main" })
      .where("owner_id", "=", scope.ownerId).where("task_id", "=", taskId).where("session_ref", "=", next.session_ref).execute();
  }

  private async lockTask(trx: ProjectTaskTrx, scope: TaskScope, taskId: string): Promise<TaskRow> {
    const row = await trx.selectFrom("project_tasks").selectAll()
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("id", "=", taskId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!row) throw new ProjectTaskError("task_not_found");
    return row;
  }

  private async moveInside(trx: ProjectTaskTrx, scope: TaskScope, current: TaskRow, to: TaskStatus): Promise<TaskRow> {
    const top = await trx.selectFrom("project_tasks").select("rank")
      .where("owner_id", "=", scope.ownerId).where("project_id", "=", scope.projectId)
      .where("status", "=", to).where("deleted_at", "is", null).where("id", "<>", current.id)
      .orderBy("rank", "asc").limit(1).executeTakeFirst();
    const at = this.now();
    const row = await trx.updateTable("project_tasks")
      .set({ status: to, rank: rankBetween(null, top?.rank ?? null), updated_at: at, revision: sql<number>`revision + 1` })
      .where("owner_id", "=", scope.ownerId).where("id", "=", current.id).returningAll().executeTakeFirstOrThrow();
    await this.log(trx, scope, current.id, AUTOMATION_ACTOR, "moved",
      `${TASK_STATUS_LABEL[current.status as TaskStatus]} → ${TASK_STATUS_LABEL[to]}`, at);
    return row;
  }

  private async touch(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, at: Date): Promise<void> {
    await trx.updateTable("project_tasks").set({ updated_at: at, revision: sql<number>`revision + 1` })
      .where("owner_id", "=", scope.ownerId).where("id", "=", taskId).execute();
  }

  private async log(trx: ProjectTaskTrx, scope: TaskScope, taskId: string, actor: ActorRef, kind: TaskActivityKind, summary: string, at: Date): Promise<void> {
    await trx.insertInto("project_task_activity").values({
      owner_id: scope.ownerId, project_id: scope.projectId, task_id: taskId, actor, kind, summary: clip(summary, 400), created_at: at,
    }).execute();
  }
}
