import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX, type WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile } from "./state-ops.js";

export type TaskStatus = "todo" | "running" | "waiting" | "blocked" | "complete" | "archived";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskRecord {
  id: string;
  projectSlug: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  order: number;
  parentTaskId?: string;
  dueAt?: string;
  linkedSessionId?: string;
  linkedWorktreeId?: string;
  previewIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

type Result<T> = { ok: true; status?: number } & T;

const TaskIdSchema = z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/);
const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const WorktreeIdSchema = z.string().regex(/^wt_[A-Za-z0-9_-]{1,128}$/);
const PreviewIdSchema = z.string().regex(/^prev_[A-Za-z0-9_-]{1,128}$/);

const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(["todo", "running", "waiting", "blocked", "complete", "archived"]).default("todo"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  order: z.number().finite().default(0),
  parentTaskId: TaskIdSchema.optional(),
  dueAt: z.string().min(1).max(64).optional(),
  linkedSessionId: SessionIdSchema.optional(),
  linkedWorktreeId: WorktreeIdSchema.optional(),
  previewIds: z.array(PreviewIdSchema).max(20).default([]),
});

const UpdateTaskSchema = CreateTaskSchema.partial().extend({
  status: z.enum(["todo", "running", "waiting", "blocked", "complete", "archived"]).optional(),
});

const ListTasksSchema = z.object({
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: TaskIdSchema.optional(),
});

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function tasksDir(homePath: string, projectSlug: string): string {
  return join(homePath, "projects", projectSlug, "tasks");
}

function taskPath(homePath: string, projectSlug: string, taskId: string): string {
  return join(tasksDir(homePath, projectSlug), `${taskId}.json`);
}

function projectConfigPath(homePath: string, projectSlug: string): string {
  return join(homePath, "projects", projectSlug, "config.json");
}

function validateProjectSlug(projectSlug: string): Failure | null {
  return ProjectSlugSchema.safeParse(projectSlug).success
    ? null
    : failure(400, "invalid_project_slug", "Project slug is invalid");
}

async function requireProject(homePath: string, projectSlug: string): Promise<Failure | null> {
  return await pathExists(projectConfigPath(homePath, projectSlug))
    ? null
    : failure(404, "not_found", "Project was not found");
}

function validateTaskId(taskId: string): Failure | null {
  return TaskIdSchema.safeParse(taskId).success
    ? null
    : failure(400, "invalid_task_id", "Task identifier is invalid");
}

async function readTask(homePath: string, projectSlug: string, taskId: string): Promise<TaskRecord | null> {
  try {
    return await readJsonFile<TaskRecord>(taskPath(homePath, projectSlug, taskId));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function listTaskRecords(homePath: string, projectSlug: string): Promise<TaskRecord[]> {
  let entries;
  try {
    entries = await readdir(tasksDir(homePath, projectSlug), { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const tasks: TaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const taskId = entry.name.slice(0, -".json".length);
    if (!TaskIdSchema.safeParse(taskId).success) continue;
    const task = await readTask(homePath, projectSlug, taskId);
    if (task) tasks.push(task);
  }
  return tasks;
}

export function createTaskManager(options: { homePath: string; now?: () => string }) {
  const homePath = resolve(options.homePath);

  return {
    async createTask(projectSlug: string, input: unknown): Promise<Result<{ task: TaskRecord }> | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const missingProject = await requireProject(homePath, projectSlug);
      if (missingProject) return missingProject;
      const parsed = CreateTaskSchema.safeParse(input);
      if (!parsed.success) {
        return failure(400, "invalid_task", "Task payload is invalid");
      }
      const timestamp = nowIso(options.now);
      const status = parsed.data.status;
      const task: TaskRecord = {
        id: `task_${randomUUID()}`,
        projectSlug,
        title: parsed.data.title,
        description: parsed.data.description,
        status,
        priority: parsed.data.priority,
        order: parsed.data.order,
        parentTaskId: parsed.data.parentTaskId,
        dueAt: parsed.data.dueAt,
        linkedSessionId: parsed.data.linkedSessionId,
        linkedWorktreeId: parsed.data.linkedWorktreeId,
        previewIds: parsed.data.previewIds,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: status === "archived" ? timestamp : undefined,
      };
      await atomicWriteJson(taskPath(homePath, projectSlug, task.id), task);
      return { ok: true, status: 201, task };
    },

    async listTasks(projectSlug: string, input: unknown = {}): Promise<
      Result<{ tasks: TaskRecord[]; nextCursor: string | null }> | Failure
    > {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const missingProject = await requireProject(homePath, projectSlug);
      if (missingProject) return missingProject;
      const parsed = ListTasksSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_task_query", "Task query is invalid");

      const query = parsed.data;
      const allTasks = (await listTaskRecords(homePath, projectSlug))
        .filter((task) => query.includeArchived || task.status !== "archived")
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const startIndex = query.cursor ? allTasks.findIndex((task) => task.id === query.cursor) + 1 : 0;
      const page = allTasks.slice(Math.max(0, startIndex), Math.max(0, startIndex) + query.limit);
      const nextCursor = allTasks.length > Math.max(0, startIndex) + query.limit ? page.at(-1)?.id ?? null : null;
      return { ok: true, tasks: page, nextCursor };
    },

    async updateTask(projectSlug: string, taskId: string, input: unknown): Promise<Result<{ task: TaskRecord }> | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const missingProject = await requireProject(homePath, projectSlug);
      if (missingProject) return missingProject;
      const taskError = validateTaskId(taskId);
      if (taskError) return taskError;
      const parsed = UpdateTaskSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_task", "Task payload is invalid");
      const existing = await readTask(homePath, projectSlug, taskId);
      if (!existing) return failure(404, "not_found", "Task was not found");

      const timestamp = nowIso(options.now);
      const nextStatus = parsed.data.status ?? existing.status;
      const task: TaskRecord = {
        ...existing,
        ...parsed.data,
        status: nextStatus,
        updatedAt: timestamp,
        archivedAt: nextStatus === "archived" ? existing.archivedAt ?? timestamp : undefined,
      };
      await atomicWriteJson(taskPath(homePath, projectSlug, taskId), task);
      return { ok: true, task };
    },

    async deleteTask(projectSlug: string, taskId: string): Promise<{ ok: true } | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const missingProject = await requireProject(homePath, projectSlug);
      if (missingProject) return missingProject;
      const taskError = validateTaskId(taskId);
      if (taskError) return taskError;
      const path = taskPath(homePath, projectSlug, taskId);
      if (!await pathExists(path)) return failure(404, "not_found", "Task was not found");
      await rm(path, { force: true });
      return { ok: true };
    },
  };
}
