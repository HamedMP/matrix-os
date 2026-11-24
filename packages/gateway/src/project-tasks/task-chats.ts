/**
 * Every task is a chat (spec 2699 amendment). The chat repository calls this
 * hook inside each project chat write, so a chat and its task commit together:
 * a new project chat gets a task, a renamed or archived chat renames or
 * archives its task, a chat moved between projects moves its task, and a
 * deleted chat soft-deletes its task. Boards hear about these changes from the
 * chat outbox after commit. Organization-owned chats get tasks with
 * organization sharing (stack 2).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  ActorRefSchema, IsoDateTimeSchema, TaskDescriptionSchema, TaskIdSchema, TaskLabelSchema, TaskPrioritySchema, TaskStatusSchema,
  TASK_LIMITS, type ActorRef,
} from "@matrix-os/contracts/project-tasks";
import type { ProjectChatExecutor, ProjectChatHook, ProjectChatSnapshot } from "../chat/project-chat-hook.js";
import type { ProjectConfig } from "../project-manager.js";
import type { OwnerScope } from "../state-ops.js";
import type { ProjectTaskTrx } from "./database.js";
import { ProjectTaskError } from "./errors.js";
import type { ProjectTaskRepository, TaskRow, TaskScope } from "./repository.js";
import { defaultTaskKey } from "./service.js";

/** What a board create (or the backfill) hands the chat create; plain chats pass none. */
export const TicketSeedSchema = z.object({
  description: TaskDescriptionSchema.optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignee: ActorRefSchema.nullable().optional(),
  labels: z.array(TaskLabelSchema).max(TASK_LIMITS.labels).optional(),
  parentTaskId: TaskIdSchema.nullable().optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  afterTaskId: TaskIdSchema.optional(),
  actor: ActorRefSchema.optional(),
  /** Backfill: link this existing task, which has no chat yet, instead of inserting one. */
  linkTaskId: TaskIdSchema.optional(),
}).strict();
export type TicketSeed = z.output<typeof TicketSeedSchema>;

/**
 * A chat started directly (Chat app, CLI, agent tool) lands in To do while it
 * has no turns; its first accepted turn moves it to In progress (see
 * `ProjectTaskService.chatChanged`). Refines the user's "new chats are In
 * progress" choice; set this to "in_progress" to revert.
 */
export const DIRECT_CHAT_STATUS = "todo" as const;
const CHAT_ACTOR: ActorRef = "system:chat";

export interface ProjectChatHookOptions {
  repository: ProjectTaskRepository;
  projects: {
    getProjectById(ownerScope: OwnerScope, projectId: string): Promise<
      | { ok: true; project: ProjectConfig }
      | { ok: false; status: number; error: { code: string; message: string } }
    >;
  };
}

function board(trx: ProjectChatExecutor): ProjectTaskTrx {
  // One owner database: the chat transaction is the board's transaction.
  return trx as unknown as ProjectTaskTrx;
}

export function createProjectChatHook(options: ProjectChatHookOptions): ProjectChatHook {
  const { repository } = options;

  /** The chat's project, or null when it no longer exists for this owner. */
  async function project(ownerId: string, projectId: string): Promise<ProjectConfig | null> {
    const result = await options.projects.getProjectById({ type: "user", id: ownerId }, projectId);
    if (result.ok) return result.project;
    if (result.status === 404 || result.status === 400) return null;
    console.warn("[project-tasks] project lookup for a chat failed", result.error.code);
    throw new ProjectTaskError("board_unavailable");
  }

  async function insert(trx: ProjectTaskTrx, ownerId: string, chat: ProjectChatSnapshot, config: ProjectConfig, seed: TicketSeed): Promise<void> {
    const scope: TaskScope = { ownerId, projectId: config.id };
    await repository.ensureBoardInside(trx, scope, defaultTaskKey(config.slug));
    if (seed.linkTaskId) {
      await repository.linkChatInside(trx, scope, seed.linkTaskId, chat.id);
      return;
    }
    await repository.insertTaskInside(trx, scope, {
      id: `task_${randomUUID()}`, chatId: chat.id, title: chat.title, archived: chat.lifecycle === "archived",
      status: seed.status ?? DIRECT_CHAT_STATUS,
      ...(seed.description !== undefined ? { description: seed.description } : {}),
      ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
      ...(seed.assignee !== undefined ? { assignee: seed.assignee } : {}),
      ...(seed.labels !== undefined ? { labels: seed.labels } : {}),
      ...(seed.parentTaskId !== undefined ? { parentTaskId: seed.parentTaskId } : {}),
      ...(seed.dueAt !== undefined ? { dueAt: seed.dueAt } : {}),
      ...(seed.afterTaskId !== undefined ? { afterTaskId: seed.afterTaskId } : {}),
    }, seed.actor ?? CHAT_ACTOR);
  }

  async function mirror(trx: ProjectTaskTrx, row: TaskRow, chat: ProjectChatSnapshot): Promise<TaskRow> {
    let next = await repository.mirrorTitleInside(trx, row, chat.title, CHAT_ACTOR);
    const archived = chat.lifecycle === "archived";
    if (archived !== (next.archived_at !== null)) {
      next = (await repository.setArchivedInside(trx, { ownerId: next.owner_id, projectId: next.project_id }, next.id, archived, CHAT_ACTOR)).row;
    }
    return next;
  }

  return {
    async created(trx, owner, chat, ticket) {
      if (owner.type !== "personal" || chat.projectId === null) return;
      const seed = TicketSeedSchema.parse(ticket ?? {});
      const config = await project(owner.ownerId, chat.projectId);
      if (!config) return;
      await insert(board(trx), owner.ownerId, chat, config, seed);
    },

    async updated(trx, owner, _before, after) {
      if (owner.type !== "personal") return;
      const db = board(trx);
      const row = await repository.findByChat(db, owner.ownerId, after.id, true);
      if (after.projectId === null) {
        // A chat taken out of its project leaves its task archived on the old board.
        if (row && row.archived_at === null) {
          await repository.setArchivedInside(db, { ownerId: row.owner_id, projectId: row.project_id }, row.id, true, CHAT_ACTOR);
        }
        return;
      }
      const config = await project(owner.ownerId, after.projectId);
      if (!config) return;
      if (!row) {
        await insert(db, owner.ownerId, after, config, {});
        return;
      }
      const placed = row.project_id === config.id ? row : await repository.moveProjectInside(
        db, row, { ownerId: owner.ownerId, projectId: config.id }, defaultTaskKey(config.slug), CHAT_ACTOR,
      );
      // Title and archived state follow the chat; a chat moved back into a project restores its task.
      await mirror(db, placed, after);
    },

    async deleted(trx, owner, chatId) {
      if (owner.type !== "personal") return;
      const db = board(trx);
      const row = await repository.findByChat(db, owner.ownerId, chatId, true);
      if (!row) return;
      await repository.deleteTaskInside(db, { ownerId: row.owner_id, projectId: row.project_id }, row.id, CHAT_ACTOR);
    },
  };
}
