import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX, type ProjectConfig, type WorkspaceError } from "./project-manager.js";
import { atomicCreateJson, atomicWriteJson, withProjectLock, type OwnerScope } from "./state-ops.js";
import {
  projectStateRecoveryDir,
  readBoundedJsonFileWithIdentity,
  removeFileIfUnchanged,
} from "./bounded-json-file.js";
import { createProjectRegistry } from "./project-registry.js";

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
const TimestampSchema = z.string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const WorktreeRecordSchema = z.object({
  id: WorktreeIdSchema,
  projectSlug: SlugSchema,
  path: z.string().min(1).max(4_096),
  sourceBranch: BranchSchema,
  currentBranch: BranchSchema,
  pr: z.object({
    number: z.number().int().positive().max(10_000_000),
    title: z.string().max(500).optional(),
    headRef: BranchSchema.optional(),
    baseRef: BranchSchema.optional(),
  }).optional(),
  dirtyState: z.enum(["unknown", "clean", "dirty"]),
  dirtyCount: z.number().int().nonnegative().max(1_000_000).optional(),
  createdAt: TimestampSchema,
  lastGitRefreshAt: TimestampSchema.optional(),
});
const WorktreeLeaseSchema = z.object({
  id: z.string().regex(/^lease_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  projectSlug: SlugSchema,
  worktreeId: WorktreeIdSchema,
  holderType: z.enum(["session", "review"]),
  holderId: z.string().min(1).max(256),
  mode: z.literal("write"),
  acquiredAt: TimestampSchema,
  heartbeatAt: TimestampSchema,
  recoverableAfter: TimestampSchema.optional(),
});
const DEFAULT_TIMEOUT_MS = 10_000;
const LEASE_TTL_MS = 30 * 60_000;
const MAX_WORKTREE_RECORD_BYTES = 256 * 1024;

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

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function gitRefExists(runCommand: CommandRunner, cwd: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    return true;
  } catch (err: unknown) {
    if (err instanceof Error) return false;
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

async function readProject(homePath: string, projectSlug: string): Promise<ProjectConfig | null> {
  return await createProjectRegistry({ homePath }).readConfig<ProjectConfig>(projectSlug);
}

export function managedWorktreePath(homePath: string, projectSlug: string, id: string): string {
  if (!SlugSchema.safeParse(projectSlug).success || !WorktreeIdSchema.safeParse(id).success) {
    throw new Error("Invalid managed worktree identity");
  }
  return join(resolve(homePath), "worktrees", projectSlug, id);
}

function legacyWorktreePath(homePath: string, projectSlug: string, id: string): string {
  return join(resolve(homePath), "projects", projectSlug, "worktrees", id);
}

export async function resolveWorktreeCheckoutPath(
  homePath: string,
  projectSlug: string,
  id: string,
): Promise<string | null> {
  const candidates = [
    managedWorktreePath(homePath, projectSlug, id),
    legacyWorktreePath(homePath, projectSlug, id),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  // Preserve the pre-separation deterministic path for legacy callers and
  // test doubles that resolve the filesystem later. New manager-created
  // worktrees always materialize the canonical candidate first.
  return candidates[1]!;
}

function worktreeRecordPath(homePath: string, projectSlug: string, id: string): string {
  return join(createProjectRegistry({ homePath }).worktreesDir(projectSlug), id, "worktree.json");
}

function worktreeLeasePath(homePath: string, projectSlug: string, id: string): string {
  return join(createProjectRegistry({ homePath }).worktreesDir(projectSlug), id, "lease.json");
}

function legacyWorktreeMetadataPath(homePath: string, projectSlug: string, id: string, name: string): string {
  return join(legacyWorktreePath(homePath, projectSlug, id), ".matrix", name);
}

function parseWorktreeRecord(
  value: unknown,
  homePath: string,
  projectSlug: string,
  id: string,
): WorktreeRecord | null {
  const parsed = WorktreeRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.projectSlug !== projectSlug || parsed.data.id !== id) return null;
  const recordPath = resolve(parsed.data.path);
  const allowedPaths = [
    managedWorktreePath(homePath, projectSlug, id),
    legacyWorktreePath(homePath, projectSlug, id),
  ];
  return allowedPaths.includes(recordPath) ? parsed.data : null;
}

function parseWorktreeLease(
  value: unknown,
  projectSlug: string,
  worktreeId: string,
): WorktreeLease | null {
  const parsed = WorktreeLeaseSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.projectSlug !== projectSlug
    || parsed.data.worktreeId !== worktreeId
  ) {
    return null;
  }
  return parsed.data;
}

async function migrateLegacyMetadata<T extends { id: string }>(input: {
  homePath: string;
  legacyPath: string;
  canonicalPath: string;
  backupName: string;
  parse: (value: unknown) => T | null;
}): Promise<T | null> {
  const legacyCandidate = await readBoundedJsonFileWithIdentity(
    input.legacyPath,
    MAX_WORKTREE_RECORD_BYTES,
  );
  if (!legacyCandidate) return null;
  const legacy = input.parse(legacyCandidate.value);
  if (!legacy) return null;
  const created = await atomicCreateJson(input.canonicalPath, legacy);
  const canonicalCandidate = created
    ? { value: legacy }
    : await readBoundedJsonFileWithIdentity(input.canonicalPath, MAX_WORKTREE_RECORD_BYTES);
  const canonical = input.parse(canonicalCandidate?.value);
  if (!canonical) return null;
  if (canonical.id !== legacy.id) return canonical;

  const backupPath = join(dirname(input.canonicalPath), input.backupName);
  await atomicCreateJson(backupPath, legacy);
  await removeFileIfUnchanged(input.legacyPath, legacyCandidate.identity, {
    recoveryDir: projectStateRecoveryDir(input.homePath),
  });
  return canonical;
}

async function readWorktree(homePath: string, projectSlug: string, id: string): Promise<WorktreeRecord | null> {
  const canonicalPath = worktreeRecordPath(homePath, projectSlug, id);
  const candidate = await readBoundedJsonFileWithIdentity(canonicalPath, MAX_WORKTREE_RECORD_BYTES);
  if (candidate) return parseWorktreeRecord(candidate.value, homePath, projectSlug, id);
  if (await pathEntryExists(canonicalPath)) return null;
  return await migrateLegacyMetadata<WorktreeRecord>({
    homePath,
    legacyPath: legacyWorktreeMetadataPath(homePath, projectSlug, id, "worktree.json"),
    canonicalPath,
    backupName: "legacy-worktree.json",
    parse: (value) => parseWorktreeRecord(value, homePath, projectSlug, id),
  });
}

async function readLease(homePath: string, projectSlug: string, id: string): Promise<WorktreeLease | null> {
  const path = worktreeLeasePath(homePath, projectSlug, id);
  const candidate = await readBoundedJsonFileWithIdentity(path, MAX_WORKTREE_RECORD_BYTES);
  if (candidate) return parseWorktreeLease(candidate.value, projectSlug, id);
  if (await pathEntryExists(path)) return null;
  return await migrateLegacyMetadata<WorktreeLease>({
    homePath,
    legacyPath: legacyWorktreeMetadataPath(homePath, projectSlug, id, "lease.json"),
    canonicalPath: path,
    backupName: "legacy-lease.json",
    parse: (value) => parseWorktreeLease(value, projectSlug, id),
  });
}

async function recoverInvalidLeaseUnderLock(
  homePath: string,
  projectSlug: string,
  id: string,
): Promise<WorktreeLease | null> {
  const path = worktreeLeasePath(homePath, projectSlug, id);
  const quarantinePath = join(dirname(path), `.lease-${randomUUID()}.quarantine`);
  try {
    await rename(path, quarantinePath);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }

  let quarantined: WorktreeLease | null = null;
  const candidate = await readBoundedJsonFileWithIdentity(
    quarantinePath,
    MAX_WORKTREE_RECORD_BYTES,
  );
  if (candidate) quarantined = parseWorktreeLease(candidate.value, projectSlug, id);

  if (!quarantined) {
    await rm(quarantinePath, { force: true });
    return null;
  }

  // A valid lease may have replaced the invalid pathname after the pure read.
  // Restore it exclusively; if another process already published a winner,
  // observe that winner instead of overwriting it.
  const restored = await atomicCreateJson(path, quarantined);
  await rm(quarantinePath, { force: true });
  return restored ? quarantined : await readLease(homePath, projectSlug, id);
}

export function createWorktreeManager(options: {
  homePath: string;
  runCommand?: CommandRunner;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;

  return {
    async getWorktree(
      projectSlug: string,
      id: string,
      ownerScope?: OwnerScope,
    ): Promise<{ ok: true; worktree: WorktreeRecord } | Failure> {
      if (!SlugSchema.safeParse(projectSlug).success || !WorktreeIdSchema.safeParse(id).success) {
        return failure(400, "invalid_ref", "Worktree reference is invalid");
      }
      const project = await readProject(homePath, projectSlug);
      const worktree = project && !project.archivedAt && !project.deletingAt && (!ownerScope
        || (project.ownerScope.type === ownerScope.type && project.ownerScope.id === ownerScope.id))
        ? await readWorktree(homePath, projectSlug, id)
        : null;
      return worktree
        ? { ok: true, worktree }
        : failure(404, "not_found", "Worktree was not found");
    },

    async createWorktree(input: {
      projectSlug: string;
      ownerScope?: OwnerScope;
      branch?: string;
      createBranch?: boolean;
      baseRef?: string;
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
      if (input.baseRef && !BranchSchema.safeParse(input.baseRef).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      if (typeof input.pr === "number" && (!Number.isSafeInteger(input.pr) || input.pr < 1)) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const project = await readProject(homePath, input.projectSlug);
        if (!project || (input.ownerScope
          && (project.ownerScope.type !== input.ownerScope.type || project.ownerScope.id !== input.ownerScope.id))) {
          return failure(404, "not_found", "Project was not found");
        }

        const source = typeof input.pr === "number" ? `pull/${input.pr}/head` : input.branch!;
        const id = worktreeId(input.projectSlug, source);
        const path = managedWorktreePath(homePath, input.projectSlug, id);
        const currentBranch = typeof input.pr === "number" ? `pr-${input.pr}` : input.branch!;
        const configuredBaseRef = input.baseRef ?? project.defaultBranch ?? "main";
        const baseRef = BranchSchema.safeParse(configuredBaseRef).success ? configuredBaseRef : "main";
        const existing = await readWorktree(homePath, input.projectSlug, id);
        if (existing) return { ok: true, status: 200, worktree: existing };
        if (await pathEntryExists(path)) {
          return failure(409, "worktree_path_conflict", "Worktree checkout requires recovery");
        }

        try {
          if (typeof input.pr === "number") {
            await runCommand("git", ["fetch", "origin", `${source}:refs/heads/${currentBranch}`], {
              cwd: project.localPath,
              timeout: DEFAULT_TIMEOUT_MS,
            });
          }
          let addArgs = ["worktree", "add", "--", path, currentBranch];
          if (input.branch && input.createBranch) {
            const branchExists = await gitRefExists(runCommand, project.localPath, `refs/heads/${currentBranch}`);
            if (!branchExists) {
              const remoteRef = `refs/remotes/origin/${currentBranch}`;
              const remoteBranchExists = await gitRefExists(runCommand, project.localPath, remoteRef);
              addArgs = remoteBranchExists
                ? ["worktree", "add", "-b", currentBranch, "--track", "--", path, `origin/${currentBranch}`]
                : ["worktree", "add", "-b", currentBranch, "--", path, baseRef];
            }
          }
          await runCommand("git", addArgs, {
            cwd: project.localPath,
            timeout: DEFAULT_TIMEOUT_MS,
          });
        } catch (err: unknown) {
          if (err instanceof Error) console.warn("[worktree-manager] Failed to add worktree:", err.message);
          else console.warn("[worktree-manager] Failed to add worktree:", err);
          // Git may have left a recoverable checkout, or another actor may
          // have created the deterministic path after our preflight. Never
          // recursively delete an unproven path from this failure boundary.
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
        await atomicWriteJson(worktreeRecordPath(homePath, input.projectSlug, id), record);
        return { ok: true, status: 201, worktree: record };
      });
    },

    async listWorktrees(projectSlug: string, ownerScope?: OwnerScope): Promise<{ ok: true; worktrees: WorktreeRecord[] } | Failure> {
      if (!SlugSchema.safeParse(projectSlug).success) {
        return failure(400, "invalid_slug", "Project slug is invalid");
      }
      const project = await readProject(homePath, projectSlug);
      if (!project || (ownerScope
        && (project.ownerScope.type !== ownerScope.type || project.ownerScope.id !== ownerScope.id))) {
        return failure(404, "not_found", "Project was not found");
      }
      const roots = [
        createProjectRegistry({ homePath }).worktreesDir(projectSlug),
        join(homePath, "projects", projectSlug, "worktrees"),
      ];
      const ids = new Set<string>();
      for (const root of roots) {
        try {
          const entries = await readdir(root, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) ids.add(entry.name);
          }
        } catch (err: unknown) {
          if (!isErrnoCode(err, "ENOENT")) throw err;
        }
      }
      const worktrees: WorktreeRecord[] = [];
      for (const id of ids) {
        const record = await readWorktree(homePath, projectSlug, id);
        if (record) worktrees.push(record);
      }
      return { ok: true, worktrees };
    },

    async listActiveLeases(projectSlug: string): Promise<{ ok: true; leases: WorktreeLease[] } | Failure> {
      const listed = await this.listWorktrees(projectSlug);
      if (!listed.ok) return listed;
      const leases: WorktreeLease[] = [];
      const timestamp = nowIso(options.now);
      for (const worktree of listed.worktrees) {
        const lease = await readLease(homePath, projectSlug, worktree.id);
        if (lease && !isLeaseStale(lease, timestamp)) leases.push(lease);
      }
      return { ok: true, leases };
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
        const leasePath = worktreeLeasePath(homePath, input.projectSlug, input.worktreeId);
        const timestamp = nowIso(options.now);
        let existing = await readLease(homePath, input.projectSlug, input.worktreeId);
        if (!existing && await pathEntryExists(leasePath)) {
          existing = await recoverInvalidLeaseUnderLock(homePath, input.projectSlug, input.worktreeId);
        }
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
          const winner = await readLease(homePath, input.projectSlug, input.worktreeId);
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
        const leasePath = worktreeLeasePath(homePath, input.projectSlug, input.worktreeId);
        let existing = await readLease(homePath, input.projectSlug, input.worktreeId);
        if (!existing && await pathEntryExists(leasePath)) {
          existing = await recoverInvalidLeaseUnderLock(homePath, input.projectSlug, input.worktreeId);
        }
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
      ownerScope?: OwnerScope;
    }): Promise<{ ok: true } | Failure> {
      if (!SlugSchema.safeParse(input.projectSlug).success || !WorktreeIdSchema.safeParse(input.worktreeId).success) {
        return failure(400, "invalid_ref", "Branch or PR reference is invalid");
      }
      return withProjectLock(input.projectSlug, async () => {
        const project = await readProject(homePath, input.projectSlug);
        const record = await readWorktree(homePath, input.projectSlug, input.worktreeId);
        const allowedPaths = project ? new Set([
          managedWorktreePath(homePath, input.projectSlug, input.worktreeId),
          legacyWorktreePath(homePath, input.projectSlug, input.worktreeId),
        ]) : new Set<string>();
        if (!project
          || (input.ownerScope
            && (project.ownerScope.type !== input.ownerScope.type || project.ownerScope.id !== input.ownerScope.id))
          || !record
          || !allowedPaths.has(resolve(record.path))
          || !await pathExists(record.path)) {
          return failure(404, "not_found", "Worktree was not found");
        }
        const path = resolve(record.path);
        let lease = await readLease(homePath, input.projectSlug, input.worktreeId);
        if (!lease && await pathEntryExists(worktreeLeasePath(homePath, input.projectSlug, input.worktreeId))) {
          lease = await recoverInvalidLeaseUnderLock(homePath, input.projectSlug, input.worktreeId);
        }
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
            cwd: project.localPath,
            timeout: DEFAULT_TIMEOUT_MS,
          });
          if (await pathExists(path)) await rm(path, { recursive: true, force: true });
        } catch (err: unknown) {
          if (err instanceof Error) console.warn("[worktree-manager] Failed to remove git worktree metadata:", err.message);
          await rm(path, { recursive: true, force: true });
        }
        await rm(join(createProjectRegistry({ homePath }).worktreesDir(input.projectSlug), input.worktreeId), {
          recursive: true,
          force: true,
        });
        return { ok: true };
      });
    },
  };
}
