import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX, type WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile } from "./state-ops.js";

export type PreviewStatus = "unknown" | "ok" | "failed";
export type PreviewDisplayPreference = "panel" | "external";

export interface PreviewRecord {
  id: string;
  projectSlug: string;
  taskId?: string;
  sessionId?: string;
  label: string;
  url: string;
  lastStatus: PreviewStatus;
  displayPreference: PreviewDisplayPreference;
  createdAt: string;
  updatedAt: string;
}

type ProbeResult = { ok: true } | { ok: false; code: string };
type ProbeUrl = (url: string, options: { timeoutMs: number }) => Promise<ProbeResult>;

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

type Result<T> = { ok: true; status?: number } & T;

const DEFAULT_PROJECT_CAP = 100;
const DEFAULT_TASK_CAP = 20;
const PROBE_TIMEOUT_MS = 10_000;

const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const PreviewIdSchema = z.string().regex(/^prev_[A-Za-z0-9_-]{1,128}$/);
const TaskIdSchema = z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);

const BasePreviewSchema = z.object({
  taskId: TaskIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
  displayPreference: z.enum(["panel", "external"]).default("panel"),
});

const CreatePreviewSchema = BasePreviewSchema;

const UpdatePreviewSchema = BasePreviewSchema.partial().extend({
  lastStatus: z.enum(["unknown", "ok", "failed"]).optional(),
});

const ListPreviewSchema = z.object({
  taskId: TaskIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  cursor: PreviewIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(100),
});

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function previewsDir(homePath: string, projectSlug: string): string {
  return join(homePath, "projects", projectSlug, "previews");
}

function previewPath(homePath: string, projectSlug: string, previewId: string): string {
  return join(previewsDir(homePath, projectSlug), `${previewId}.json`);
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

function validPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (err: unknown) {
    if (err instanceof TypeError) return false;
    return false;
  }
}

async function defaultProbeUrl(url: string, options: { timeoutMs: number }): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return response.status < 500 ? { ok: true } : { ok: false, code: "preview_probe_failed" };
  } catch (err: unknown) {
    if (err instanceof Error) {
      return { ok: false, code: "preview_probe_failed" };
    }
    return { ok: false, code: "preview_probe_failed" };
  }
}

async function readPreview(homePath: string, projectSlug: string, previewId: string): Promise<PreviewRecord | null> {
  try {
    return await readJsonFile<PreviewRecord>(previewPath(homePath, projectSlug, previewId));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function listPreviewRecords(homePath: string, projectSlug: string): Promise<PreviewRecord[]> {
  let entries;
  try {
    entries = await readdir(previewsDir(homePath, projectSlug), { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const previews: PreviewRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const previewId = entry.name.slice(0, -".json".length);
    if (!PreviewIdSchema.safeParse(previewId).success) continue;
    const preview = await readPreview(homePath, projectSlug, previewId);
    if (preview) previews.push(preview);
  }
  return previews;
}

function validateProjectSlug(projectSlug: string): Failure | null {
  return ProjectSlugSchema.safeParse(projectSlug).success
    ? null
    : failure(400, "invalid_project_slug", "Project slug is invalid");
}

function validatePreviewId(previewId: string): Failure | null {
  return PreviewIdSchema.safeParse(previewId).success
    ? null
    : failure(400, "invalid_preview_id", "Preview identifier is invalid");
}

function detectPreviewUrls(text: string): string[] {
  const urls = new Set<string>();
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s)"']*)?/g;
  for (const match of text.matchAll(pattern)) {
    urls.add(match[0].replace(/[.,;:]+$/, ""));
  }
  return [...urls];
}

export function createPreviewManager(options: {
  homePath: string;
  probeUrl?: ProbeUrl;
  maxPreviewsPerProject?: number;
  maxPreviewsPerTask?: number;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const probeUrl = options.probeUrl ?? defaultProbeUrl;
  const projectCap = options.maxPreviewsPerProject ?? DEFAULT_PROJECT_CAP;
  const taskCap = options.maxPreviewsPerTask ?? DEFAULT_TASK_CAP;

  return {
    detectPreviewUrls,

    async createPreview(projectSlug: string, input: unknown): Promise<Result<{ preview: PreviewRecord }> | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const parsed = CreatePreviewSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_preview", "Preview payload is invalid");
      if (!validPreviewUrl(parsed.data.url)) {
        return failure(400, "invalid_preview_url", "Preview URL is invalid");
      }

      const existing = await listPreviewRecords(homePath, projectSlug);
      if (existing.length >= projectCap) {
        return failure(409, "preview_limit_exceeded", "Preview limit exceeded");
      }
      if (parsed.data.taskId && existing.filter((preview) => preview.taskId === parsed.data.taskId).length >= taskCap) {
        return failure(409, "preview_limit_exceeded", "Preview limit exceeded");
      }

      const probe = await probeUrl(parsed.data.url, { timeoutMs: PROBE_TIMEOUT_MS });
      const timestamp = nowIso(options.now);
      const preview: PreviewRecord = {
        id: `prev_${randomUUID()}`,
        projectSlug,
        taskId: parsed.data.taskId,
        sessionId: parsed.data.sessionId,
        label: parsed.data.label,
        url: parsed.data.url,
        lastStatus: probe.ok ? "ok" : "failed",
        displayPreference: parsed.data.displayPreference,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await atomicWriteJson(previewPath(homePath, projectSlug, preview.id), preview);
      return { ok: true, status: 201, preview };
    },

    async listPreviews(projectSlug: string, input: unknown = {}): Promise<
      Result<{ previews: PreviewRecord[]; nextCursor: string | null }> | Failure
    > {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const parsed = ListPreviewSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_preview_query", "Preview query is invalid");
      const query = parsed.data;
      const previews = (await listPreviewRecords(homePath, projectSlug))
        .filter((preview) => !query.taskId || preview.taskId === query.taskId)
        .filter((preview) => !query.sessionId || preview.sessionId === query.sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const startIndex = query.cursor ? previews.findIndex((preview) => preview.id === query.cursor) + 1 : 0;
      const page = previews.slice(Math.max(0, startIndex), Math.max(0, startIndex) + query.limit);
      const nextCursor = previews.length > Math.max(0, startIndex) + query.limit ? page.at(-1)?.id ?? null : null;
      return { ok: true, previews: page, nextCursor };
    },

    async updatePreview(projectSlug: string, previewId: string, input: unknown): Promise<Result<{ preview: PreviewRecord }> | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const previewError = validatePreviewId(previewId);
      if (previewError) return previewError;
      const parsed = UpdatePreviewSchema.safeParse(input);
      if (!parsed.success) return failure(400, "invalid_preview", "Preview payload is invalid");
      if (parsed.data.url && !validPreviewUrl(parsed.data.url)) {
        return failure(400, "invalid_preview_url", "Preview URL is invalid");
      }
      const existing = await readPreview(homePath, projectSlug, previewId);
      if (!existing) return failure(404, "not_found", "Preview was not found");

      const nextStatus = parsed.data.url
        ? (await probeUrl(parsed.data.url, { timeoutMs: PROBE_TIMEOUT_MS })).ok ? "ok" : "failed"
        : parsed.data.lastStatus ?? existing.lastStatus;
      const preview: PreviewRecord = {
        ...existing,
        ...parsed.data,
        lastStatus: nextStatus,
        updatedAt: nowIso(options.now),
      };
      await atomicWriteJson(previewPath(homePath, projectSlug, previewId), preview);
      return { ok: true, preview };
    },

    async deletePreview(projectSlug: string, previewId: string): Promise<{ ok: true } | Failure> {
      const projectError = validateProjectSlug(projectSlug);
      if (projectError) return projectError;
      const previewError = validatePreviewId(previewId);
      if (previewError) return previewError;
      const path = previewPath(homePath, projectSlug, previewId);
      if (!await pathExists(path)) return failure(404, "not_found", "Preview was not found");
      await rm(path, { force: true });
      return { ok: true };
    },
  };
}
