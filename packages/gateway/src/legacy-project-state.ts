import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { removeFileIfUnchanged } from "./bounded-json-file.js";

const MAX_LEGACY_STATE_ENTRIES = 10_000;
const MAX_LEGACY_RECORD_BYTES = 256 * 1024;
const ProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const TaskIdSchema = z.string().regex(/^task_[A-Za-z0-9_-]{1,128}$/);
const PreviewIdSchema = z.string().regex(/^prev_[A-Za-z0-9_-]{1,128}$/);
const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const WorktreeIdSchema = z.string().regex(/^wt_[A-Za-z0-9_-]{1,128}$/);

const LegacyTaskRecordSchema = z.object({
  id: TaskIdSchema,
  projectSlug: ProjectSlugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(["todo", "running", "waiting", "blocked", "complete", "archived"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  order: z.number().finite(),
  parentTaskId: TaskIdSchema.optional(),
  dueAt: z.string().min(1).max(64).optional(),
  linkedSessionId: SessionIdSchema.optional(),
  linkedWorktreeId: WorktreeIdSchema.optional(),
  previewIds: z.array(PreviewIdSchema).max(20),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  archivedAt: z.string().max(64).optional(),
});

const LegacyPreviewRecordSchema = z.object({
  id: PreviewIdSchema,
  projectSlug: ProjectSlugSchema,
  taskId: TaskIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  label: z.string().min(1).max(120),
  url: z.string().min(1).max(2_048),
  lastStatus: z.enum(["unknown", "ok", "failed"]),
  displayPreference: z.enum(["panel", "external"]),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
});

type LegacyRecord = { id: string; projectSlug: string };
type Candidate = { path: string; dev: number; ino: number; size: number; mtimeMs: number };

function isMissing(err: unknown): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function collectValidatedRecords(
  directory: string,
  projectSlug: string,
  schema: z.ZodType<LegacyRecord>,
): Promise<Candidate[]> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (err: unknown) {
    if (isMissing(err)) return [];
    throw err;
  }
  const candidates: Candidate[] = [];
  let visited = 0;
  for await (const entry of entries) {
    visited += 1;
    if (visited > MAX_LEGACY_STATE_ENTRIES) {
      throw new Error("Legacy project state exceeds the safe deletion limit");
    }
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    let handle;
    try {
      handle = await open(path, "r");
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_LEGACY_RECORD_BYTES) continue;
      const buffer = Buffer.alloc(stats.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_LEGACY_RECORD_BYTES) continue;
      let value: unknown;
      try {
        value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf-8"));
      } catch (err: unknown) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success || parsed.data.projectSlug !== projectSlug || entry.name !== `${parsed.data.id}.json`) continue;
      candidates.push({
        path,
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (err: unknown) {
      if (!isMissing(err)) throw err;
    } finally {
      await handle?.close();
    }
  }
  return candidates;
}

async function removeCandidate(
  candidate: Candidate,
  recoveryDir: string,
  onValidatedBeforeQuarantine?: () => Promise<void>,
): Promise<void> {
  await removeFileIfUnchanged(candidate.path, candidate, {
    recoveryDir,
    onValidatedBeforeQuarantine,
  });
}

export async function removeValidatedLegacyProjectState(input: {
  projectSlug: string;
  tasksDir: string;
  previewsDir: string;
  recoveryDir: string;
  /** @internal deterministic concurrency-test seam */
  onCandidateValidated?: () => Promise<void>;
}): Promise<void> {
  const candidates = await validatedLegacyProjectStateCandidates(input);
  for (const [index, candidate] of candidates.entries()) {
    await removeCandidate(
      candidate,
      input.recoveryDir,
      index === 0 ? input.onCandidateValidated : undefined,
    );
  }
}

async function validatedLegacyProjectStateCandidates(input: {
  projectSlug: string;
  tasksDir: string;
  previewsDir: string;
}): Promise<Candidate[]> {
  const taskCandidates = await collectValidatedRecords(
    input.tasksDir,
    input.projectSlug,
    LegacyTaskRecordSchema,
  );
  const previewCandidates = await collectValidatedRecords(
    input.previewsDir,
    input.projectSlug,
    LegacyPreviewRecordSchema,
  );
  return [...taskCandidates, ...previewCandidates];
}

export async function listValidatedLegacyProjectStateFiles(input: {
  projectSlug: string;
  tasksDir: string;
  previewsDir: string;
}): Promise<string[]> {
  return (await validatedLegacyProjectStateCandidates(input)).map((candidate) => candidate.path);
}
