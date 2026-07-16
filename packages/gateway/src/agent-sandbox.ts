import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import {
  buildAgentLaunch,
  SupportedAgentSchema,
  type AgentLaunchSandbox,
  type SupportedAgent,
} from "./agent-launcher.js";
import type { WorkspaceError } from "./project-manager.js";

export interface AgentSandboxStatus {
  available: boolean;
  enforced: boolean;
  requiresAdminOverride: boolean;
  reason: "ok" | "not_required" | "root_user" | "admin_override";
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
  sandboxStatus?: AgentSandboxStatus;
};

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const ScratchCleanupSchema = z.object({ sessionId: SessionIdSchema }).strict();
const PreflightSchema = z.object({
  agent: SupportedAgentSchema,
  sessionId: SessionIdSchema,
  worktreePath: z.string().trim().min(1).max(4096),
  adminOverride: z.boolean().optional(),
  mode: z.enum(["default", "plan", "review", "full_access"]).optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "on-failure", "never"]).optional(),
  sandboxMode: z.enum(["read_only", "workspace_write", "full_access"]).optional(),
});

type ClaudeSandboxVerifier = (input: {
  cwd: string;
  runtimeHome: string;
  mode?: "default" | "plan" | "review" | "full_access";
  sandbox: AgentLaunchSandbox;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
}) => Promise<void>;
// Resolves the Git common dir for a workspace, or null when the workspace is
// not inside a Git repository (no Git metadata exists to protect).
type GitCommonDirResolver = (worktreePath: string) => Promise<string | null>;

const execFileAsync = promisify(execFile);
const CLAUDE_PREFLIGHT_TIMEOUT_MS = 5_000;
const GIT_METADATA_TIMEOUT_MS = 5_000;
const SCRATCH_STALE_AFTER_MS = 30 * 60_000;
const MAX_SESSION_STATE_BYTES = 64 * 1024;
const SessionStateSchema = z.object({
  id: SessionIdSchema,
  runtime: z.object({
    status: z.enum(["starting", "running", "idle", "waiting", "exited", "failed", "degraded"]),
  }).passthrough(),
}).passthrough();

const defaultClaudeSandboxVerifier: ClaudeSandboxVerifier = async (input) => {
  const launch = buildAgentLaunch({
    agent: "claude",
    cwd: input.cwd,
    runtimeHome: input.runtimeHome,
    mode: input.mode,
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
  });
  await execFileAsync(launch.command, [...launch.args, "--init-only"], {
    cwd: launch.cwd,
    timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
    encoding: "utf-8",
    maxBuffer: 64 * 1024,
    env: { ...process.env, ...launch.env },
  });
};

const defaultGitCommonDirResolver: GitCommonDirResolver = async (worktreePath) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: worktreePath,
        timeout: GIT_METADATA_TIMEOUT_MS,
        encoding: "utf-8",
        maxBuffer: 8 * 1024,
      },
    );
    return z.string().trim().min(1).max(4096).parse(stdout);
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
      ? (err as { stderr: string }).stderr
      : "";
    // Scratch and folder projects are not required to be Git repositories.
    if (/not a git repository/i.test(stderr)) return null;
    throw err;
  }
};

function failure(status: number, code: string, message: string, sandboxStatus?: AgentSandboxStatus): Failure {
  return { ok: false, status, error: { code, message }, sandboxStatus };
}

function sandboxRequired(agent: SupportedAgent): boolean {
  return agent === "codex" || agent === "claude";
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

async function canonicalDirectoryWithinHome(
  homePath: string,
  candidatePath: string,
): Promise<{ kind: "ok"; path: string } | { kind: "missing" } | { kind: "invalid" }> {
  try {
    const candidateStat = await lstat(candidatePath);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return { kind: "invalid" };
    const [canonicalHome, canonicalCandidate] = await Promise.all([
      realpath(homePath),
      realpath(candidatePath),
    ]);
    if (!isWithinHome(canonicalHome, canonicalCandidate)) return { kind: "invalid" };
    return { kind: "ok", path: canonicalCandidate };
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return { kind: "missing" };
    throw err;
  }
}

function statusForUid(uid: number, required: boolean): AgentSandboxStatus {
  if (!required) {
    return {
      available: true,
      enforced: false,
      requiresAdminOverride: false,
      reason: "not_required",
    };
  }
  if (uid === 0) {
    return {
      available: false,
      enforced: false,
      requiresAdminOverride: true,
      reason: "root_user",
    };
  }
  return {
    available: true,
    enforced: true,
    requiresAdminOverride: false,
    reason: "ok",
  };
}

function currentUid(getUid?: () => number): number {
  if (getUid) return getUid();
  if (typeof process.getuid === "function") return process.getuid();
  return 1000;
}

function isWithinHome(homePath: string, candidatePath: string): boolean {
  const resolved = resolve(candidatePath);
  return resolved === homePath || resolved.startsWith(`${homePath}/`);
}

async function sessionMayOwnScratch(homePath: string, sessionId: string): Promise<boolean> {
  const path = join(homePath, "system", "sessions", `${sessionId}.json`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_SESSION_STATE_BYTES) return true;
    const parsed = SessionStateSchema.safeParse(JSON.parse(await handle.readFile("utf-8")));
    if (!parsed.success) return true;
    return ["starting", "running", "idle", "waiting", "degraded"].includes(parsed.data.runtime.status);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return false;
    return true;
  } finally {
    await handle?.close();
  }
}

async function reclaimStaleScratchPath(
  homePath: string,
  sessionId: string,
  nowMs: () => number,
): Promise<boolean> {
  const scratchPath = join(homePath, "system", "agent-scratch", sessionId);
  try {
    const scratchStat = await lstat(scratchPath);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) return false;
    if (nowMs() - scratchStat.mtimeMs < SCRATCH_STALE_AFTER_MS) return false;
    if (await sessionMayOwnScratch(homePath, sessionId)) return false;
    return cleanupScratchPath(homePath, sessionId);
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return true;
    throw err;
  }
}

async function prepareScratchPath(
  homePath: string,
  sessionId: string,
  nowMs: () => number,
): Promise<string | null> {
  const scratchRoot = join(homePath, "system", "agent-scratch");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(scratchRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const [canonicalHome, canonicalScratchRoot] = await Promise.all([
    realpath(homePath),
    realpath(scratchRoot),
  ]);
  if (canonicalScratchRoot !== join(canonicalHome, "system", "agent-scratch")) return null;

  const scratchPath = join(scratchRoot, sessionId);
  try {
    await mkdir(scratchPath, { mode: 0o700 });
    return scratchPath;
  } catch (err: unknown) {
    if (!isErrnoCode(err, "EEXIST")) throw err;
    if (!await reclaimStaleScratchPath(homePath, sessionId, nowMs)) return null;
    try {
      await mkdir(scratchPath, { mode: 0o700 });
      return scratchPath;
    } catch (retryErr: unknown) {
      if (isErrnoCode(retryErr, "EEXIST")) return null;
      throw retryErr;
    }
  }
}

async function cleanupScratchPath(homePath: string, sessionId: string): Promise<boolean> {
  const scratchRoot = join(homePath, "system", "agent-scratch");
  try {
    const rootStat = await lstat(scratchRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const [canonicalHome, canonicalScratchRoot] = await Promise.all([
      realpath(homePath),
      realpath(scratchRoot),
    ]);
    if (canonicalScratchRoot !== join(canonicalHome, "system", "agent-scratch")) return false;

    const scratchPath = join(scratchRoot, sessionId);
    const scratchStat = await lstat(scratchPath);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) return false;
    if (await realpath(scratchPath) !== join(canonicalScratchRoot, sessionId)) return false;
    await rm(scratchPath, { recursive: true, force: true });
    return true;
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) return true;
    throw err;
  }
}

export function createAgentSandbox(options: {
  homePath: string;
  getUid?: () => number;
  verifyClaudeSandbox?: ClaudeSandboxVerifier;
  resolveGitCommonDir?: GitCommonDirResolver;
  nowMs?: () => number;
}) {
  const homePath = resolve(options.homePath);
  const verifyClaudeSandbox = options.verifyClaudeSandbox ?? defaultClaudeSandboxVerifier;
  const resolveGitCommonDir = options.resolveGitCommonDir ?? defaultGitCommonDirResolver;
  const nowMs = options.nowMs ?? Date.now;

  return {
    async cleanup(input: unknown): Promise<void> {
      const parsed = ScratchCleanupSchema.safeParse(input);
      if (!parsed.success) return;
      await cleanupScratchPath(homePath, parsed.data.sessionId);
    },

    async status(input?: { agent?: SupportedAgent }): Promise<AgentSandboxStatus> {
      const required = input?.agent ? sandboxRequired(input.agent) : true;
      return statusForUid(currentUid(options.getUid), required);
    },

    async preflight(input: unknown): Promise<
      | { ok: true; sandbox: AgentLaunchSandbox | undefined; status: AgentSandboxStatus }
      | Failure
    > {
      const parsed = PreflightSchema.safeParse(input);
      if (!parsed.success) {
        return failure(400, "invalid_sandbox_request", "Sandbox request is invalid");
      }
      const request = parsed.data;
      const required = sandboxRequired(request.agent);
      if (!required) {
        return {
          ok: true,
          sandbox: undefined,
          status: statusForUid(currentUid(options.getUid), false),
        };
      }

      const uid = currentUid(options.getUid);
      const uidStatus = statusForUid(uid, true);
      if (uidStatus.requiresAdminOverride) {
        if (request.agent === "claude") {
          return failure(403, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
        }
        if (request.adminOverride === true) {
          return {
            ok: true,
            sandbox: { enabled: false, adminOverride: true },
            status: {
              available: false,
              enforced: false,
              requiresAdminOverride: true,
              reason: "admin_override",
            },
          };
        }
        return failure(403, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
      }

      const resolvedWorktree = resolve(request.worktreePath);
      if (!isWithinHome(homePath, resolvedWorktree)) {
        return failure(400, "invalid_worktree_path", "Worktree path is invalid");
      }
      const canonicalWorktree = await canonicalDirectoryWithinHome(homePath, resolvedWorktree);
      if (canonicalWorktree.kind === "missing") {
        return failure(404, "not_found", "Worktree was not found");
      }
      if (canonicalWorktree.kind === "invalid") {
        return failure(400, "invalid_worktree_path", "Worktree path is invalid");
      }

      const sandboxMode = request.sandboxMode ?? "workspace_write";
      const effectiveReadOnly = sandboxMode === "read_only" ||
        (request.agent === "claude" && (request.mode === "plan" || request.mode === "review"));
      let denyWriteRoots: string[] | undefined;
      if (effectiveReadOnly && request.agent === "claude") {
        try {
          const commonDirRaw = await resolveGitCommonDir(canonicalWorktree.path);
          if (commonDirRaw === null) {
            // Non-Git workspaces (scratch/folder projects) have no Git
            // metadata to protect; review stays read-only over the workspace
            // root alone instead of failing closed.
            denyWriteRoots = [canonicalWorktree.path];
          } else {
            const gitCommonPath = resolve(canonicalWorktree.path, commonDirRaw);
            const canonicalGitCommon = await canonicalDirectoryWithinHome(homePath, gitCommonPath);
            if (canonicalGitCommon.kind !== "ok") {
              return failure(503, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
            }
            denyWriteRoots = [...new Set([canonicalWorktree.path, canonicalGitCommon.path])];
          }
        } catch (err: unknown) {
          console.warn(
            "[agent-sandbox] Claude read-only Git metadata preflight failed:",
            err instanceof Error ? err.message : String(err),
          );
          return failure(503, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
        }
      }

      const scratchPath = sandboxMode === "workspace_write" && !effectiveReadOnly
        ? await prepareScratchPath(homePath, request.sessionId, nowMs)
        : null;
      if (sandboxMode === "workspace_write" && !effectiveReadOnly && !scratchPath) {
        return failure(409, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
      }
      const sandbox: AgentLaunchSandbox = effectiveReadOnly
        ? { enabled: true, mode: "read-only", writableRoots: [], denyWriteRoots }
        : sandboxMode === "full_access"
          ? { enabled: true, mode: "danger-full-access", writableRoots: [] }
          : {
            enabled: true,
            mode: "workspace-write",
            writableRoots: [canonicalWorktree.path, scratchPath!],
          };

      if (request.agent === "claude") {
        try {
          await verifyClaudeSandbox({
            cwd: canonicalWorktree.path,
            runtimeHome: homePath,
            mode: request.mode,
            sandbox,
            approvalPolicy: request.approvalPolicy,
          });
        } catch (err: unknown) {
          console.warn(
            "[agent-sandbox] Claude sandbox preflight failed:",
            err instanceof Error ? err.message : String(err),
          );
          if (scratchPath) await cleanupScratchPath(homePath, request.sessionId);
          return failure(503, "sandbox_unavailable", "Agent sandbox is unavailable", uidStatus);
        }
      }
      return {
        ok: true,
        sandbox,
        status: uidStatus,
      };
    },
  };
}
