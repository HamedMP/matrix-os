import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX, type ProjectConfig, type WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile, withProjectLock } from "./state-ops.js";

export interface WorktreeRecord {
  id: string;
  projectSlug: string;
  path: string;
  sourceBranch: string;
  currentBranch: string;
  pr?: {
    number: number;
    title?: string;
    headRef?: string;
    baseRef?: string;
  };
  dirtyState: "unknown" | "clean" | "dirty";
  dirtyCount?: number;
  createdAt: string;
  lastGitRefreshAt?: string;
}

export interface WorktreeLease {
  id: string;
  projectSlug: string;
  worktreeId: string;
  holderType: "session" | "review";
  holderId: string;
  mode: "write";
  acquiredAt: string;
  heartbeatAt: string;
  recoverableAfter?: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

type Failure = { ok: false; status: number; error: WorkspaceError };

const BranchSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?![-/])(?:[A-Za-z0-9._/-]+)$/)
  .refine((value) => !value.includes("..") && !value.endsWith("/") && !value.endsWith(".lock"));
const SlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
const WorktreeIdSchema = z.string().regex(/^wt_[a-z0-9]{12,40}$/);
const DEFAULT_TIMEOUT_MS = 10_000;
const LEASE_TTL_MS = 30 * 60_000;

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout, stderr };
};

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

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function isLeaseStale(lease: WorktreeLease, now: string): boolean {
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(heartbeatMs) && Number.isFinite(nowMs) && nowMs - heartbeatMs > LEASE_TTL_MS;
}

function worktreeId(projectSlug: string, source: string): string {
  return `wt_${createHash("sha256").update(`${projectSlug}:${source}`).digest("hex").slice(0, 16)}`;
}

function projectConfigPath(homePath: string, projectSlug: string): string {
  return join(homePath, "projects", projectSlug, "config.json");
}

async function readProject(homePath: string, projectSlug: string): Promise<ProjectConfig | null> {
  try {
    return await readJsonFile<ProjectConfig>(projectConfigPath(homePath, projectSlug));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function worktreePath(homePath: string, projectSlug: string, id: string): string {
  return join(homePath, "projects", projectSlug, "worktrees", id);
}

async function readWorktree(homePath: string, projectSlug: string, id: string): Promise<WorktreeRecord | null> {
  try {
    return await readJsonFile<WorktreeRecord>(join(worktreePath(homePath, projectSlug, id), ".matrix", "worktree.json"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function readLease(path: string): Promise<WorktreeLease | null> {
  try {
    return await readJsonFile<WorktreeLease>(path);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function createWorktreeManager(options: {
  homePath: string;
  runCommand?: CommandRunner;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;

  return {
    async createWorktree(input: {
      projectSlug: string;
      branch?: string;
      pr?: number;
    }): Promise<{ ok: true; status: 201 | 200; worktree: WorktreeRecord } | Failure> {
      if (!SlugSchema.safeParse(input.projectSlug).success) {
        return failure(400, "invalid_slug", "Project slug is invalid");
      }
      if ((input.branch ? 1 : 0) + (typeof input.pr === "number" ? 1 : 0) !== 1) {
        return failure(400, "invalid_ref", "Exactly one branch or PR reference is required");
      }
      if (input.branch && !BranchSchema.safeParse(input.branch).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      if (typeof input.pr === "number" && (!Number.isSafeInteger(input.pr) || input.pr < 1)) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const project = await readProject(homePath, input.projectSlug);
        if (!project) return failure(404, "not_found", "Project was not found");

        const source = typeof input.pr === "number" ? `pull/${input.pr}/head` : input.branch!;
        const id = worktreeId(input.projectSlug, source);
        const path = worktreePath(homePath, input.projectSlug, id);
        const currentBranch = typeof input.pr === "number" ? `pr-${input.pr}` : input.branch!;
        const existing = await readWorktree(homePath, input.projectSlug, id);
        if (existing) return { ok: true, status: 200, worktree: existing };

        try {
          if (typeof input.pr === "number") {
            await runCommand("git", ["fetch", "origin", `${source}:refs/heads/${currentBranch}`], {
              cwd: project.localPath,
              timeout: DEFAULT_TIMEOUT_MS,
            });
          }
          await runCommand("git", ["worktree", "add", "--", path, currentBranch], {
            cwd: project.localPath,
            timeout: DEFAULT_TIMEOUT_MS,
          });
        } catch (err: unknown) {
          if (err instanceof Error) console.warn("[worktree-manager] Failed to add worktree:", err.message);
          else console.warn("[worktree-manager] Failed to add worktree:", err);
          await rm(path, { recursive: true, force: true });
          return failure(502, "checkout_failed", "Worktree checkout failed");
        }
        const timestamp = nowIso(options.now);
        const record: WorktreeRecord = {
          id,
          projectSlug: input.projectSlug,
          path,
          sourceBranch: source,
          currentBranch,
          pr: typeof input.pr === "number" ? { number: input.pr } : undefined,
          dirtyState: "unknown",
          createdAt: timestamp,
        };
        await atomicWriteJson(join(path, ".matrix", "worktree.json"), record);
        return { ok: true, status: 201, worktree: record };
      });
    },

    async listWorktrees(projectSlug: string): Promise<{ ok: true; worktrees: WorktreeRecord[] } | Failure> {
      if (!SlugSchema.safeParse(projectSlug).success) {
        return failure(400, "invalid_slug", "Project slug is invalid");
      }
      const root = join(homePath, "projects", projectSlug, "worktrees");
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: true, worktrees: [] };
        }
        throw err;
      }
      const worktrees: WorktreeRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const record = await readWorktree(homePath, projectSlug, entry.name);
        if (record) worktrees.push(record);
      }
      return { ok: true, worktrees };
    },

    async acquireLease(input: {
      projectSlug: string;
      worktreeId: string;
      holderType: "session" | "review";
      holderId: string;
    }): Promise<{ ok: true; lease: WorktreeLease } | { ok: false; status: 409; holderId: string } | Failure> {
      if (!SlugSchema.safeParse(input.projectSlug).success || !WorktreeIdSchema.safeParse(input.worktreeId).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const leasePath = join(worktreePath(homePath, input.projectSlug, input.worktreeId), ".matrix", "lease.json");
        const timestamp = nowIso(options.now);
        const existing = await readLease(leasePath);
        if (existing) {
          if (existing.holderId !== input.holderId && !isLeaseStale(existing, timestamp)) {
            return { ok: false, status: 409, holderId: existing.holderId };
          }
          if (existing.holderId === input.holderId) {
            const refreshed = { ...existing, heartbeatAt: timestamp };
            await atomicWriteJson(leasePath, refreshed);
            return { ok: true, lease: refreshed };
          }
          await unlink(leasePath).catch((err: unknown) => {
            if (isErrnoCode(err, "ENOENT")) return;
            throw err;
          });
        }

        const lease: WorktreeLease = {
          id: `lease_${randomUUID()}`,
          projectSlug: input.projectSlug,
          worktreeId: input.worktreeId,
          holderType: input.holderType,
          holderId: input.holderId,
          mode: "write",
          acquiredAt: timestamp,
          heartbeatAt: timestamp,
        };
        try {
          await mkdir(dirname(leasePath), { recursive: true });
          await writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
          return { ok: true, lease };
        } catch (err: unknown) {
          if (!isErrnoCode(err, "EEXIST")) throw err;
          const winner = await readLease(leasePath);
          if (winner?.holderId === input.holderId) return { ok: true, lease: winner };
          return { ok: false, status: 409, holderId: winner?.holderId ?? "unknown" };
        }
      });
    },

    async releaseLease(input: {
      projectSlug: string;
      worktreeId: string;
      holderId: string;
    }): Promise<{ ok: true } | Failure> {
      if (!SlugSchema.safeParse(input.projectSlug).success || !WorktreeIdSchema.safeParse(input.worktreeId).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const leasePath = join(worktreePath(homePath, input.projectSlug, input.worktreeId), ".matrix", "lease.json");
        const existing = await readLease(leasePath);
        if (existing && existing.holderId !== input.holderId) {
          return failure(409, "worktree_locked", "Worktree is locked");
        }
        await unlink(leasePath).catch((err: unknown) => {
          if (isErrnoCode(err, "ENOENT")) return;
          throw err;
        });
        return { ok: true };
      });
    },

    async deleteWorktree(input: {
      projectSlug: string;
      worktreeId: string;
      confirmDirtyDelete?: boolean;
    }): Promise<{ ok: true } | Failure> {
      if (!SlugSchema.safeParse(input.projectSlug).success || !WorktreeIdSchema.safeParse(input.worktreeId).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const path = worktreePath(homePath, input.projectSlug, input.worktreeId);
        if (!await pathExists(path)) return failure(404, "not_found", "Worktree was not found");
        const lease = await readLease(join(path, ".matrix", "lease.json"));
        if (lease) return failure(409, "worktree_locked", "Worktree is locked");

        let dirtyCount = 0;
        try {
          const result = await runCommand("git", ["status", "--porcelain"], {
            cwd: path,
            timeout: DEFAULT_TIMEOUT_MS,
          });
          dirtyCount = result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
        } catch (err: unknown) {
          if (err instanceof Error) console.warn("[worktree-manager] Failed to inspect dirty state:", err.message);
          if (!input.confirmDirtyDelete) {
            return failure(409, "dirty_state_unknown", "Dirty worktree deletion requires confirmation");
          }
          dirtyCount = 0;
        }
        if (dirtyCount > 0 && !input.confirmDirtyDelete) {
          return failure(409, "dirty_worktree_confirmation_required", "Dirty worktree deletion requires confirmation");
        }
        try {
          await runCommand("git", ["worktree", "remove", "--force", "--", path], {
            cwd: join(homePath, "projects", input.projectSlug, "repo"),
            timeout: DEFAULT_TIMEOUT_MS,
          });
          if (await pathExists(path)) await rm(path, { recursive: true, force: true });
        } catch (err: unknown) {
          if (err instanceof Error) console.warn("[worktree-manager] Failed to remove git worktree metadata:", err.message);
          await rm(path, { recursive: true, force: true });
        }
        return { ok: true };
      });
    },
  };
}
