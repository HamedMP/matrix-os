import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX, type WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile } from "./state-ops.js";

export interface ActivityEvent {
  id: string;
  scope: {
    projectSlug?: string;
    taskId?: string;
    sessionId?: string;
    reviewId?: string;
    previewId?: string;
  };
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

type Result<T> = { ok: true } & T;

const DEFAULT_MAX_EVENTS = 5_000;

const EventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_-]{1,128}$/);
const ScopeSchema = z.object({
  projectSlug: z.string().regex(PROJECT_SLUG_REGEX).optional(),
  taskId: z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/).optional(),
  sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/).optional(),
  reviewId: z.string().regex(/^rev_[A-Za-z0-9_-]{1,128}$/).optional(),
  previewId: z.string().regex(/^prev_[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

const PublishEventSchema = z.object({
  scope: ScopeSchema,
  type: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const ListEventsSchema = z.object({
  projectSlug: z.string().regex(PROJECT_SLUG_REGEX).optional(),
  taskId: z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/).optional(),
  sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/).optional(),
  reviewId: z.string().regex(/^rev_[A-Za-z0-9_-]{1,128}$/).optional(),
  previewId: z.string().regex(/^prev_[A-Za-z0-9_-]{1,128}$/).optional(),
  cursor: EventIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(100),
});

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function eventsPath(homePath: string): string {
  return join(homePath, "system", "workspace-events.json");
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

async function readEvents(homePath: string): Promise<ActivityEvent[]> {
  const path = eventsPath(homePath);
  if (!await pathExists(path)) return [];
  const value = await readJsonFile<unknown>(path);
  return Array.isArray(value) ? value.filter(isActivityEvent) : [];
}

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.scope === "object" &&
    record.scope !== null &&
    typeof record.payload === "object" &&
    record.payload !== null;
}

function matchesQuery(event: ActivityEvent, query: z.infer<typeof ListEventsSchema>): boolean {
  return (!query.projectSlug || event.scope.projectSlug === query.projectSlug) &&
    (!query.taskId || event.scope.taskId === query.taskId) &&
    (!query.sessionId || event.scope.sessionId === query.sessionId) &&
    (!query.reviewId || event.scope.reviewId === query.reviewId) &&
    (!query.previewId || event.scope.previewId === query.previewId);
}

export function createWorkspaceEventStore(options: {
  homePath: string;
  maxEvents?: number;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const maxEvents = Math.max(1, Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS, DEFAULT_MAX_EVENTS));

  return {
    async publishEvent(input: unknown): Promise<Result<{ event: ActivityEvent }> | Failure> {
      const parsed = PublishEventSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_event_scope", "Workspace event scope is invalid");
      const event: ActivityEvent = {
        id: `evt_${randomUUID()}`,
        scope: parsed.data.scope,
        type: parsed.data.type,
        payload: parsed.data.payload,
        createdAt: nowIso(options.now),
      };
      const events = [...await readEvents(homePath), event].slice(-maxEvents);
      await atomicWriteJson(eventsPath(homePath), events);
      return { ok: true, event };
    },

    async listEvents(input: unknown = {}): Promise<Result<{ events: ActivityEvent[]; nextCursor: string | null }> | Failure> {
      const parsed = ListEventsSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_event_query", "Workspace event query is invalid");
      const query = parsed.data;
      const events = (await readEvents(homePath)).filter((event) => matchesQuery(event, query));
      const startIndex = query.cursor ? events.findIndex((event) => event.id === query.cursor) + 1 : 0;
      const page = events.slice(Math.max(0, startIndex), Math.max(0, startIndex) + query.limit);
      const nextCursor = events.length > Math.max(0, startIndex) + query.limit ? page.at(-1)?.id ?? null : null;
      return { ok: true, events: page, nextCursor };
    },
  };
}
