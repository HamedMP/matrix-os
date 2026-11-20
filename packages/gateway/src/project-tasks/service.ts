/**
 * ProjectTaskService: the one owner of board behavior (spec 2699). Routes, the
 * CLI and agent tools all go through it. It resolves the project for the
 * caller's owner scope, runs the one-time legacy import, maps rows to the wire
 * contract, and publishes change signals after each commit.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ActorRef, BoardMember, BoardSettings, CreateTaskBodySchema, TaskComment, ListTasksQuerySchema, MoveTaskBodySchema, ProjectTask, TaskActivity,
  UpdateTaskBodySchema,
} from "@matrix-os/contracts/project-tasks";
import type { z } from "zod/v4";
import type { ProjectConfig } from "../project-manager.js";
import type { OwnerScope } from "../state-ops.js";
import type { createTaskManager } from "../task-manager.js";
import { ProjectTaskCommentRepository, toTaskComment } from "./comments.js";
import { ProjectTaskError } from "./errors.js";
import { assignmentNotification, commentNotifications, type TaskNotification } from "./notifications.js";
import { mapLegacyTasks, readLegacyTasks } from "./legacy-import.js";
import {
  ProjectTaskRepository, RevisionConflict, toProjectTask, toTaskActivity, type BoardRow, type TaskRow, type TaskScope,
} from "./repository.js";

type ProjectLookup = {
  getProject(slug: string, ownerScope?: OwnerScope): Promise<
    | { ok: true; project: ProjectConfig }
    | { ok: false; status: number; error: { code: string; message: string } }
  >;
};
type LegacyTasks = Pick<ReturnType<typeof createTaskManager>, "listTasks">;

export type TaskEventType = "task.created" | "task.updated" | "task.moved" | "task.deleted" | "task.comment_added";
export type TaskEventPublisher = (event: { type: TaskEventType; projectSlug: string; taskId: string; revision: number }) => Promise<void>;

export interface ProjectTaskServiceOptions {
  repository: ProjectTaskRepository;
  comments: ProjectTaskCommentRepository;
  /** Who can be assigned and mentioned; the owner alone until organization sharing (stack 2). */
  members(caller: TaskCaller): Promise<BoardMember[]>;
  /** Delivery for assignment, mention and comment notifications. */
  notify?(notification: TaskNotification, ownerScope: OwnerScope): Promise<void>;
  projects: ProjectLookup;
  legacyTasks: LegacyTasks;
  publish: TaskEventPublisher;
}

/** The caller resolved from the request principal; never from a body. */
export interface TaskCaller {
  ownerScope: OwnerScope;
  actor: ActorRef;
}

export interface BoardContext {
  slug: string;
  project: ProjectConfig;
  scope: TaskScope;
  board: BoardRow;
}

type ListQuery = z.output<typeof ListTasksQuerySchema>;
type CreateTaskBody = z.output<typeof CreateTaskBodySchema>;
type UpdateTaskBody = z.output<typeof UpdateTaskBodySchema>;
type MoveTaskBody = z.output<typeof MoveTaskBodySchema>;

/** A board prefix from the project slug: initials of a multi-word slug, else its first letters. */
export function defaultTaskKey(slug: string): string {
  const words = slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "");
  const key = (letters.length >= 2 ? letters : (words.join("") || "TASK")).replace(/^[0-9]+/, "").slice(0, 4);
  return /^[A-Z][A-Z0-9]{1,9}$/.test(key) ? key : "TASK";
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ProjectTaskService {
  constructor(private readonly options: ProjectTaskServiceOptions) {}

  /** Resolve and prepare a project's board for the caller; imports legacy tasks once. */
  async open(caller: TaskCaller, slug: string): Promise<BoardContext> {
    const result = await this.options.projects.getProject(slug, caller.ownerScope);
    if (!result.ok) {
      if (result.status === 404 || result.status === 400) throw new ProjectTaskError("project_not_found");
      console.warn("[project-tasks] project lookup failed", result.error.code);
      throw new ProjectTaskError("board_unavailable");
    }
    const scope: TaskScope = { ownerId: caller.ownerScope.id, projectId: result.project.id };
    let board = await this.options.repository.ensureBoard(scope, defaultTaskKey(slug));
    if (board.legacy_import_at === null) {
      const legacy = await readLegacyTasks(this.options.legacyTasks, slug, caller.ownerScope);
      await this.options.repository.importLegacy(scope, legacy ? mapLegacyTasks(legacy) : []);
      board = await this.options.repository.ensureBoard(scope, defaultTaskKey(slug));
    }
    return { slug, project: result.project, scope, board };
  }

  /** Wire tasks for rows, with their relations loaded in one query. */
  async tasks(context: BoardContext, rows: readonly TaskRow[]): Promise<ProjectTask[]> {
    const blockedBy = await this.options.repository.blockedByFor(context.scope, rows.map((row) => row.id));
    return rows.map((row) => toProjectTask(row, context.board.task_key, { blockedBy: blockedBy[row.id] ?? [] }));
  }

  async task(context: BoardContext, row: TaskRow): Promise<ProjectTask> {
    return (await this.tasks(context, [row]))[0]!;
  }

  async listTasks(caller: TaskCaller, slug: string, query: ListQuery): Promise<{ tasks: ProjectTask[]; nextCursor: string | null }> {
    const context = await this.open(caller, slug);
    const { rows, nextCursor } = await this.options.repository.listTasks(context.scope, query);
    return { tasks: await this.tasks(context, rows), nextCursor };
  }

  async getTask(caller: TaskCaller, slug: string, taskId: string): Promise<ProjectTask> {
    const context = await this.open(caller, slug);
    return this.task(context, await this.requireRow(context, taskId));
  }

  async createTask(caller: TaskCaller, slug: string, body: CreateTaskBody): Promise<{ task: ProjectTask; created: boolean }> {
    const context = await this.open(caller, slug);
    const { clientRequestId, ...input } = body;
    const { row, created } = await this.options.repository.createTask(context.scope, {
      ...input, id: `task_${randomUUID()}`, clientRequestId, payloadHash: payloadHash(input),
    }, caller.actor);
    const task = await this.task(context, row);
    if (created) {
      await this.signal("task.created", context, task);
      await this.deliver(caller, assignmentNotification({ ...this.about(context, task), actor: caller.actor, assignee: task.assignee }));
    }
    return { task, created };
  }

  async updateTask(caller: TaskCaller, slug: string, taskId: string, body: UpdateTaskBody): Promise<ProjectTask> {
    const context = await this.open(caller, slug);
    const { baseRevision, ...patch } = body;
    let row: TaskRow;
    let before: TaskRow | undefined;
    try {
      before = patch.assignee !== undefined ? await this.options.repository.getTask(context.scope, taskId) : undefined;
      row = await this.options.repository.updateTask(context.scope, taskId, baseRevision, patch, caller.actor);
    } catch (error: unknown) {
      if (error instanceof RevisionConflict) throw new ProjectTaskError("task_revision_conflict", await this.task(context, error.current));
      throw error;
    }
    const task = await this.task(context, row);
    await this.signal("task.updated", context, task);
    if (before && before.assignee !== task.assignee) {
      await this.deliver(caller, assignmentNotification({ ...this.about(context, task), actor: caller.actor, assignee: task.assignee }));
    }
    return task;
  }

  async moveTask(caller: TaskCaller, slug: string, taskId: string, body: MoveTaskBody): Promise<ProjectTask> {
    const context = await this.open(caller, slug);
    const { row } = await this.options.repository.moveTask(context.scope, taskId, body, caller.actor);
    const task = await this.task(context, row);
    await this.signal("task.moved", context, task);
    return task;
  }

  async setArchived(caller: TaskCaller, slug: string, taskId: string, archived: boolean): Promise<ProjectTask> {
    const context = await this.open(caller, slug);
    const { row, changed } = await this.options.repository.setArchived(context.scope, taskId, archived, caller.actor);
    const task = await this.task(context, row);
    if (changed) await this.signal("task.updated", context, task);
    return task;
  }

  async deleteTask(caller: TaskCaller, slug: string, taskId: string): Promise<void> {
    const context = await this.open(caller, slug);
    const row = await this.options.repository.deleteTask(context.scope, taskId, caller.actor);
    await this.signal("task.deleted", context, toProjectTask(row, context.board.task_key));
  }

  async listActivity(caller: TaskCaller, slug: string, taskId: string, after: number, limit: number): Promise<{ activity: TaskActivity[]; nextCursor: string | null }> {
    const context = await this.open(caller, slug);
    await this.requireRow(context, taskId);
    const { rows, nextCursor } = await this.options.repository.listActivity(context.scope, taskId, after, limit);
    return { activity: rows.map(toTaskActivity), nextCursor };
  }

  async listComments(caller: TaskCaller, slug: string, taskId: string, cursor: string | undefined, limit: number): Promise<{ comments: TaskComment[]; nextCursor: string | null }> {
    const context = await this.open(caller, slug);
    await this.requireRow(context, taskId);
    const { rows, nextCursor } = await this.options.comments.list(context.scope, taskId, cursor, limit);
    return { comments: rows.map(toTaskComment), nextCursor };
  }

  async addComment(caller: TaskCaller, slug: string, taskId: string, body: string): Promise<TaskComment> {
    const context = await this.open(caller, slug);
    const comment = toTaskComment(await this.options.comments.add(context.scope, taskId, caller.actor, body));
    const task = await this.task(context, await this.requireRow(context, taskId));
    await this.signal("task.comment_added", context, task);
    await this.deliver(caller, commentNotifications({
      ...this.about(context, task), commentId: comment.id, author: caller.actor, body: comment.body,
      assignee: task.assignee, createdBy: task.createdBy, members: await this.options.members(caller),
    }));
    return comment;
  }

  async editComment(caller: TaskCaller, slug: string, taskId: string, commentId: string, body: string): Promise<TaskComment> {
    const context = await this.open(caller, slug);
    const comment = toTaskComment(await this.options.comments.edit(context.scope, taskId, commentId, caller.actor, body));
    await this.signal("task.comment_added", context, await this.task(context, await this.requireRow(context, taskId)));
    return comment;
  }

  async deleteComment(caller: TaskCaller, slug: string, taskId: string, commentId: string): Promise<void> {
    const context = await this.open(caller, slug);
    await this.options.comments.remove(context.scope, taskId, commentId, caller.actor);
    await this.signal("task.updated", context, await this.task(context, await this.requireRow(context, taskId)));
  }

  async listMembers(caller: TaskCaller, slug: string): Promise<BoardMember[]> {
    await this.open(caller, slug);
    return this.options.members(caller);
  }

  async getSettings(caller: TaskCaller, slug: string): Promise<BoardSettings> {
    return this.settings(await this.open(caller, slug));
  }

  async updateSettings(caller: TaskCaller, slug: string, patch: { taskKey?: string; automation?: Partial<BoardSettings["automation"]> }): Promise<BoardSettings> {
    const context = await this.open(caller, slug);
    const board = await this.options.repository.updateBoard(context.scope, patch);
    return this.settings({ ...context, board });
  }

  private settings(context: BoardContext): BoardSettings {
    return {
      projectId: context.scope.projectId,
      taskKey: context.board.task_key,
      linearConnected: false,
      automation: { ...context.board.automation },
    };
  }

  private async requireRow(context: BoardContext, taskId: string): Promise<TaskRow> {
    const row = await this.options.repository.getTask(context.scope, taskId);
    if (!row) throw new ProjectTaskError("task_not_found");
    return row;
  }

  private about(context: BoardContext, task: ProjectTask) {
    return { taskId: task.id, taskKey: task.key, taskTitle: task.title, projectSlug: context.slug };
  }

  /** Notifications go out after commit and never fail the request. */
  private async deliver(caller: TaskCaller, notifications: readonly TaskNotification[]): Promise<void> {
    if (!this.options.notify) return;
    for (const notification of notifications) {
      try {
        await this.options.notify(notification, caller.ownerScope);
      } catch (error: unknown) {
        console.warn("[project-tasks] notification failed", error instanceof Error ? error.name : typeof error);
      }
    }
  }

  /** Change signals go out after commit; a failed publish never undoes the write. */
  private async signal(type: TaskEventType, context: BoardContext, task: ProjectTask): Promise<void> {
    try {
      await this.options.publish({ type, projectSlug: context.slug, taskId: task.id, revision: task.revision });
    } catch (error: unknown) {
      console.warn("[project-tasks] change signal failed", error instanceof Error ? error.name : typeof error);
    }
  }
}
