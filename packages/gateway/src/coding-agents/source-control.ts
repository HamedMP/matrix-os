import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  SourceControlPrepareCommitRequestSchema,
  SourceControlPrepareCommitResponseSchema,
  type SourceControlPrepareCommitRequest,
  type SourceControlPrepareCommitResponse,
} from "@matrix-os/contracts";
import { GIT_ENV } from "../git-env.js";
import type { RequestPrincipal } from "../request-principal.js";

const execFileAsync = promisify(execFile);

const MAX_SOURCE_CONTROL_LOCKS = 128;
const DEFAULT_MAX_QUEUE_DEPTH = 8;
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_GIT_OUTPUT_BYTES = 128 * 1024;
const MAX_STAGED_PATCH_BYTES = 1024 * 1024;
const MAX_STATUS_LINES = 1000;

type SourceControlErrorCode =
  | "source_control_not_found"
  | "source_control_no_changes"
  | "source_control_unavailable"
  | "invalid_request";

export class CodingAgentSourceControlError extends Error {
  constructor(public readonly code: SourceControlErrorCode) {
    super(code);
  }
}

export interface CodingAgentSourceControlStore {
  prepareCommit(
    principal: RequestPrincipal,
    request: SourceControlPrepareCommitRequest,
  ): Promise<SourceControlPrepareCommitResponse>;
}

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canAccessSourceControl(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function worktreeRootFor(homePath: string, request: SourceControlPrepareCommitRequest): string {
  return resolve(homePath, "projects", request.projectId, "worktrees", request.worktreeId);
}

function fsErrorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
}

function settleSourceControlLockError(_err: unknown): void {
  console.warn("[coding-agents] source-control lock queue recovered");
}

interface SourceControlLockState {
  tail: Promise<void>;
  depth: number;
}

async function withSourceControlLock<T>(
  locks: Map<string, SourceControlLockState>,
  key: string,
  maxQueueDepth: number,
  run: () => Promise<T>,
): Promise<T> {
  let state = locks.get(key);
  if (!state && locks.size >= MAX_SOURCE_CONTROL_LOCKS) {
    throw new CodingAgentSourceControlError("source_control_unavailable");
  }
  if (!state) {
    state = { tail: Promise.resolve(), depth: 0 };
    locks.set(key, state);
  }
  if (state.depth >= maxQueueDepth) {
    throw new CodingAgentSourceControlError("source_control_unavailable");
  }
  let release!: () => void;
  const releasePromise = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const previous = state.tail;
  state.depth += 1;
  state.tail = previous.catch(settleSourceControlLockError).then(() => releasePromise);
  await previous.catch(settleSourceControlLockError);
  try {
    return await run();
  } finally {
    release();
    state.depth -= 1;
    if (state.depth === 0 && locks.get(key) === state) {
      locks.delete(key);
    }
  }
}

function normalizeBranch(value: string): string {
  const branch = value.trim();
  return branch === "HEAD" || branch.length === 0 ? "detached" : branch;
}

function statusLineCount(status: string): number {
  if (!status) return 0;
  return status.split("\n").filter((line) => line.trim().length > 0).length;
}

export function createCodingAgentSourceControlStore(options: {
  homePath: string;
  ownerId?: string;
  principalOwnerIds?: readonly string[];
  gitTimeoutMs?: number;
  gitCommand?: string;
  maxQueueDepth?: number;
}): CodingAgentSourceControlStore {
  const homePath = resolve(options.homePath);
  const ownerIds = ownerIdsFor(options);
  const gitTimeoutMs = Math.max(1000, Math.min(options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 30_000));
  const gitCommand = options.gitCommand ?? "git";
  const maxQueueDepth = Math.max(1, Math.min(options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH, 64));
  const locks = new Map<string, SourceControlLockState>();

  async function git(cwd: string, args: string[], options: { maxBuffer?: number; trim?: boolean } = {}): Promise<string> {
    const result = await execFileAsync(gitCommand, args, {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      signal: AbortSignal.timeout(gitTimeoutMs),
      maxBuffer: options.maxBuffer ?? DEFAULT_GIT_OUTPUT_BYTES,
    });
    const stdout = String(result.stdout);
    return options.trim === false ? stdout : stdout.trim();
  }

  async function gitWithInput(cwd: string, args: string[], input: string, maxBuffer: number): Promise<string> {
    return new Promise((resolveCommand, rejectCommand) => {
      const child = spawn(gitCommand, args, {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let stdout = "";
      let stderrBytes = 0;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        rejectCommand(new Error("git command timed out"));
      }, gitTimeoutMs);
      const rejectOnce = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectCommand(err);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        const next = stdout.length + chunk.length;
        if (next > maxBuffer) {
          rejectOnce(new Error("git output too large"));
          child.kill("SIGTERM");
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxBuffer) {
          rejectOnce(new Error("git error output too large"));
          child.kill("SIGTERM");
        }
      });
      child.on("error", rejectOnce);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolveCommand(stdout.trim());
          return;
        }
        rejectCommand(new Error("git command failed"));
      });
      child.stdin.end(input);
    });
  }

  async function resolveWorktree(request: SourceControlPrepareCommitRequest): Promise<string> {
    const worktreeRoot = worktreeRootFor(homePath, request);
    if (!isWithin(homePath, worktreeRoot)) {
      throw new CodingAgentSourceControlError("source_control_not_found");
    }
    try {
      const [homeReal, rootReal, stats] = await Promise.all([
        realpath(homePath),
        realpath(worktreeRoot),
        lstat(worktreeRoot),
      ]);
      if (!stats.isDirectory() || !isWithin(homeReal, rootReal)) {
        throw new CodingAgentSourceControlError("source_control_not_found");
      }
      return rootReal;
    } catch (err: unknown) {
      if (err instanceof CodingAgentSourceControlError) throw err;
      const code = fsErrorCode(err);
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
        throw new CodingAgentSourceControlError("source_control_not_found");
      }
      console.warn("[coding-agents] source-control worktree resolution failed");
      throw new CodingAgentSourceControlError("source_control_unavailable");
    }
  }

  function pathspecsFor(root: string, request: SourceControlPrepareCommitRequest): string[] {
    const paths = request.paths ?? ["."];
    for (const path of paths) {
      const target = resolve(root, path);
      if (!isWithin(root, target)) {
        throw new CodingAgentSourceControlError("invalid_request");
      }
    }
    return paths;
  }

  async function restoreStagedSnapshot(root: string, pathspecs: string[], stagedPatch: string): Promise<void> {
    await git(root, ["reset", "-q", "--", ...pathspecs]);
    if (stagedPatch.length > 0) {
      await gitWithInput(root, ["apply", "--cached", "--whitespace=nowarn", "-"], stagedPatch, MAX_STAGED_PATCH_BYTES);
    }
  }

  return {
    async prepareCommit(principal, rawRequest) {
      if (!canAccessSourceControl(principal, ownerIds)) {
        throw new CodingAgentSourceControlError("source_control_not_found");
      }
      const request = SourceControlPrepareCommitRequestSchema.parse(rawRequest);
      const root = await resolveWorktree(request);
      const pathspecs = pathspecsFor(root, request);

      return withSourceControlLock(locks, root, maxQueueDepth, async () => {
        let changedFileCount: number;
        try {
          const status = await git(root, ["status", "--porcelain", "--untracked-files=normal", "--", ...pathspecs]);
          changedFileCount = statusLineCount(status);
        } catch (err: unknown) {
          console.warn("[coding-agents] source-control status failed");
          throw new CodingAgentSourceControlError("source_control_unavailable");
        }
        if (changedFileCount === 0) {
          throw new CodingAgentSourceControlError("source_control_no_changes");
        }
        if (changedFileCount > MAX_STATUS_LINES) {
          throw new CodingAgentSourceControlError("invalid_request");
        }

        try {
          const stagedPatch = await git(root, ["diff", "--cached", "--binary", "--", ...pathspecs], {
            maxBuffer: MAX_STAGED_PATCH_BYTES,
            trim: false,
          });
          await git(root, ["add", "--", ...pathspecs]);
          try {
            await git(root, ["commit", "--only", "--no-verify", "-m", request.message, "--", ...pathspecs]);
          } catch (err: unknown) {
            try {
              await restoreStagedSnapshot(root, pathspecs, stagedPatch);
            } catch (rollbackErr: unknown) {
              console.warn("[coding-agents] source-control rollback failed");
            }
            throw err;
          }
          const [commitSha, branch] = await Promise.all([
            git(root, ["rev-parse", "HEAD"]),
            git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
          ]);
          return SourceControlPrepareCommitResponseSchema.parse({
            status: "committed",
            commitSha,
            branch: normalizeBranch(branch),
            changedFileCount,
            safeMessage: "Changes were committed.",
          });
        } catch (err: unknown) {
          console.warn("[coding-agents] source-control commit failed");
          throw new CodingAgentSourceControlError("source_control_unavailable");
        }
      });
    },
  };
}
