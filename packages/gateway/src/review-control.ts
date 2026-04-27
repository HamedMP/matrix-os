import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import type { WorkspaceError } from "./project-manager.js";

export interface ReviewPromptInput {
  projectSlug: string;
  pr: number;
  round: number;
  findingsPath: string;
  controlPath: string;
}

export const ReviewControlFileSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready_for_parse"),
    phase: z.literal("review"),
    round: z.number().int().positive(),
    findingsPath: z.string().min(1).max(512),
    writtenAt: z.string().min(1).max(64),
  }).strict(),
  z.object({
    status: z.literal("implemented"),
    phase: z.literal("implement"),
    round: z.number().int().positive(),
    commit: z.string().min(1).max(128),
    writtenAt: z.string().min(1).max(64),
  }).strict(),
  z.object({
    status: z.literal("verification_passed"),
    phase: z.literal("verify"),
    round: z.number().int().positive(),
    writtenAt: z.string().min(1).max(64),
  }).strict(),
  z.object({
    status: z.literal("verification_failed"),
    phase: z.literal("verify"),
    round: z.number().int().positive(),
    error: z.string().min(1).max(1000),
    writtenAt: z.string().min(1).max(64),
  }).strict(),
]);

export type ReviewControlFile = z.infer<typeof ReviewControlFileSchema>;

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function assertRound(round: number): void {
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new Error("Invalid review round");
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(tmpPath, path);
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

export function controlFilePath(worktreePath: string, round: number): string {
  assertRound(round);
  return join(resolve(worktreePath), ".matrix", `review-round-${round}.json`);
}

export function buildReviewerPrompt(input: ReviewPromptInput): string {
  return [
    `Review project ${input.projectSlug} PR #${input.pr}, round ${input.round}.`,
    "",
    `Write markdown findings to ${input.findingsPath}.`,
    "Use this exact structure:",
    "## Findings",
    "### Finding F-001",
    "Severity: high|medium|low",
    "File: relative/path.ts",
    "Line: 1",
    "Summary: concise issue",
    "Details: optional details",
    "",
    "If there are no findings, write exactly:",
    "## Findings",
    "None",
    "",
    `After writing findings, atomically write ${input.controlPath} with status ready_for_parse.`,
  ].join("\n");
}

export function buildImplementerPrompt(input: ReviewPromptInput): string {
  return [
    `Implement fixes for project ${input.projectSlug} PR #${input.pr}, round ${input.round}.`,
    `Read findings from ${input.findingsPath}.`,
    "Make the smallest correct code changes and commit them.",
    `After committing, atomically write ${input.controlPath} with status implemented and the commit SHA in commit.`,
  ].join("\n");
}

export async function writeReviewControlFile(input: {
  worktreePath: string;
  round: number;
  control: ReviewControlFile;
}): Promise<{ ok: true; path: string } | Failure> {
  const parsed = ReviewControlFileSchema.safeParse(input.control);
  if (!parsed.success || parsed.data.round !== input.round) {
    return failure(400, "invalid_control_file", "Review control file is invalid");
  }
  const path = controlFilePath(input.worktreePath, input.round);
  await atomicWriteJson(path, parsed.data);
  return { ok: true, path };
}

export async function readReviewControlFile(input: {
  worktreePath: string;
  round: number;
}): Promise<{ ok: true; control: ReviewControlFile } | Failure> {
  const path = controlFilePath(input.worktreePath, input.round);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return failure(404, "control_file_missing", "Review control file was not found");
    }
    if (err instanceof Error) {
      console.warn("[review-control] Failed to read control file:", err.message);
    }
    return failure(500, "control_file_unreadable", "Review control file could not be read");
  }

  try {
    const parsed = ReviewControlFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.round !== input.round) {
      return failure(400, "invalid_control_file", "Review control file is invalid");
    }
    return { ok: true, control: parsed.data };
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return failure(400, "invalid_control_file", "Review control file is invalid");
    }
    throw err;
  }
}
