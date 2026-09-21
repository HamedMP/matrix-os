import { sql, type ColumnType, type Transaction } from "kysely";
import type { CollaborationProjectGitSetup } from "@matrix-os/contracts";
import type { OwnerCollaborationDatabase } from "./database.js";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

/** Durable idempotency and audit attribution for owner-identity project Git actions. */
export interface CollaborationGitOperationsTable {
  id: string;
  scope_id: string;
  actor_id: string;
  run_id: string | null;
  client_request_id: string;
  type: "status" | "diff" | "commit" | "push" | "pr";
  state: "pending" | "running" | "completed" | "failed" | "unknown" | "reconciling";
  payload_hash: string;
  expected_revision: number;
  owner_id: string;
  owner_identity_label: string;
  request: JsonValue;
  commit_sha: string | null;
  remote_branch: string | null;
  pr_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export async function migrateProjectGitOperationsV13(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_git_operations (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      run_id TEXT,
      client_request_id UUID NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('status', 'diff', 'commit', 'push', 'pr')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'unknown', 'reconciling')),
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      owner_identity_label TEXT NOT NULL CHECK (char_length(owner_identity_label) BETWEEN 1 AND 800),
      request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
      commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[a-f0-9]{40}$'),
      remote_branch TEXT,
      pr_url TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (scope_id, actor_id, client_request_id)
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_git_operations_scope
    ON collaboration_git_operations(scope_id, created_at DESC)
  `.execute(trx);
  await sql`ALTER TABLE collaboration_audit ADD COLUMN IF NOT EXISTS detail JSONB`.execute(trx);
  await sql`
    INSERT INTO collaboration_schema_migrations (version) VALUES (13)
    ON CONFLICT (version) DO NOTHING
  `.execute(trx);
}

import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { validateGitHubUrl } from "../project-manager.js";
import { classifyPushFailure, isGitExitCode, processFailure, runProcess } from "./project-git-process.js";
import {
  AmbiguousProjectGitEffect,
  ProjectGitBrokerError,
  type ProjectGitActionResult,
  type ProjectGitDriver,
  type ProjectGitExecution,
  type ProjectGitOwnerIdentity,
} from "./project-git-broker.js";

const exec = promisify(execFile);
const GitIdentityNameSchema = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const GitIdentityEmailSchema = z.email().max(320);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const GIT_TIMEOUT_MS = 10_000;
const REMOTE_TIMEOUT_MS = 30_000;
/**
 * Repository-local configuration keys that would let a Contributor redirect,
 * intercept or rewrite an owner-credentialed remote operation. Git lowercases
 * section and variable names; subsections keep their case.
 */
const FORBIDDEN_REPOSITORY_CONFIG = Object.freeze([
  /^http\./,
  /^https\./,
  /^include\./,
  /^includeif\./,
  /^url\./,
  /^credential\./,
  /^core\.(sshcommand|gitproxy|askpass|hookspath|fsmonitor|alternaterefscommand|pager)$/,
  /^remote\..+\.(receivepack|uploadpack|proxy|proxyauthmethod)$/,
  /^diff\.external$/,
  /^diff\..+\.command$/,
  /^filter\./,
  /^gpg\.(program|.+\.program)$/,
  /^protocol\./,
  /^ssh\./,
] as const);

import type { GitCommandResult } from "./project-git-process.js";

function gitEnvironment(identity?: ProjectGitOwnerIdentity, useOwnerCredential = false): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: useOwnerCredential ? process.env.HOME ?? "/nonexistent" : "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(identity ? {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    } : {}),
  };
}

async function gitCommand(cwd: string, args: string[], identity?: ProjectGitOwnerIdentity, remote = false): Promise<GitCommandResult> {
  return exec("git", [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    ...(remote ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []),
    ...args,
  ], {
    cwd,
    env: gitEnvironment(identity, remote),
    timeout: remote ? REMOTE_TIMEOUT_MS : GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

/**
 * The owner identity comes only from the owner's global Git configuration
 * under the owner home, which is never mounted into a sandbox. The
 * member-writable repository config is deliberately not consulted.
 */
async function ownerGlobalConfig(ownerHome: string, key: "user.name" | "user.email"): Promise<string> {
  const result = await exec("git", ["config", "--global", "--get", key], {
    cwd: ownerHome,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: ownerHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

async function requireRepositoryRoot(path: string): Promise<string> {
  const resolved = await realpath(path);
  const gitDir = join(resolved, ".git");
  let top: string;
  let absoluteGitDir: string;
  try {
    const meta = await lstat(gitDir);
    if (meta.isSymbolicLink() || !meta.isDirectory()) throw new ProjectGitBrokerError("unavailable");
    top = (await gitCommand(resolved, ["rev-parse", "--show-toplevel"])).stdout.trim();
    absoluteGitDir = (await gitCommand(resolved, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  } catch (error: unknown) {
    if (error instanceof ProjectGitBrokerError) throw error;
    console.warn("[collaboration-git] repository unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
  if (await realpath(top) !== resolved || absoluteGitDir !== gitDir) throw new ProjectGitBrokerError("unavailable");
  return resolved;
}

async function currentHead(root: string): Promise<string> {
  try {
    return GitShaSchema.parse((await gitCommand(root, ["rev-parse", "HEAD"])).stdout.trim());
  } catch (error: unknown) {
    console.warn("[collaboration-git] HEAD unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
}

async function ownerRemote(root: string): Promise<{ owner: string; repo: string; url: string }> {
  await requireTrustedRepositoryConfig(root);
  let value: string;
  try {
    value = (await gitCommand(root, ["remote", "get-url", "--push", "origin"])).stdout.trim();
  } catch (error: unknown) {
    console.warn("[collaboration-git] remote unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
  const parsed = validateGitHubUrl(value);
  if (!parsed.ok || !value.startsWith("https://github.com/")) throw new ProjectGitBrokerError("unavailable");
  return { owner: parsed.owner, repo: parsed.repo, url: `https://github.com/${parsed.owner}/${parsed.repo}.git` };
}

/**
 * The gitdir is member-writable inside the sandbox and `git push`/`ls-remote`
 * honour includes that `git config --local` alone would hide. Refuse any
 * transport, credential, include or rewrite override before a remote effect.
 */
async function requireTrustedRepositoryConfig(root: string): Promise<void> {
  let names: string[];
  try {
    const result = await gitCommand(root, ["config", "--local", "--includes", "--name-only", "--list", "-z"]);
    names = result.stdout.split("\0").filter((name) => name.length > 0);
  } catch (error: unknown) {
    console.warn("[collaboration-git] repository config unreadable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
  if (names.some((name) => FORBIDDEN_REPOSITORY_CONFIG.some((pattern) => pattern.test(name)))) {
    console.warn("[collaboration-git] repository config carries a forbidden override");
    throw new ProjectGitBrokerError("unavailable");
  }
}

async function requireExpectedHead(root: string, expectedHeadSha: string): Promise<void> {
  if (await currentHead(root) !== expectedHeadSha) throw new ProjectGitBrokerError("conflict");
}

async function requireBranch(root: string, expected: string): Promise<void> {
  const branch = (await gitCommand(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (branch !== expected) throw new ProjectGitBrokerError("conflict");
}

/** Host-side Git/forge driver. Credentials remain in the owner host and never enter the scope runtime. */
export function createProjectGitDriver(options: {
  resolveProjectRoot(input: { ownerId: string; projectId: string }): Promise<string>;
  /** Owner home holding the owner's global Git configuration. Defaults to the gateway process home. */
  ownerHome?: string;
}) {
  const ownerHome = options.ownerHome ?? process.env.HOME;
  let forgeCwd: Promise<string> | undefined;
  let closed = false;

  /** Empty, owner-only directory so gh never reads the member repository or any repository-local Git config. */
  function privateForgeCwd(): Promise<string> {
    if (closed) throw new ProjectGitBrokerError("unavailable");
    forgeCwd ??= mkdtemp(join(tmpdir(), "matrix-git-forge-"));
    return forgeCwd;
  }

  /** Runs gh with the owner's credential store but without any repository, global or system Git configuration. */
  async function ghCommand(args: string[], stdin = ""): Promise<GitCommandResult> {
    if (!ownerHome) throw new ProjectGitBrokerError("unavailable");
    return runProcess("gh", args, {
      cwd: await privateForgeCwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: ownerHome,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: REMOTE_TIMEOUT_MS,
      stdin,
    });
  }

  async function root(input: { ownerId: string; projectId: string }) {
    return requireRepositoryRoot(await options.resolveProjectRoot(input));
  }

  async function ownerIdentity(): Promise<ProjectGitOwnerIdentity | "missing"> {
    if (!ownerHome) throw new ProjectGitBrokerError("unavailable");
    try {
      const [name, email] = await Promise.all([
        ownerGlobalConfig(ownerHome, "user.name"),
        ownerGlobalConfig(ownerHome, "user.email"),
      ]);
      const parsedName = GitIdentityNameSchema.parse(name);
      const parsedEmail = GitIdentityEmailSchema.parse(email);
      return { name: parsedName, email: parsedEmail, label: `${parsedName} <${parsedEmail}>` };
    } catch (error: unknown) {
      if (isGitExitCode(error, "1")) return "missing";
      console.warn("[collaboration-git] owner identity unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectGitBrokerError("unavailable");
    }
  }

  /**
   * Observe the remote once before giving up: a visible effect completes the
   * operation, a definite absence fails it, and only an unobservable remote
   * leaves the operation unknown for later reconciliation by the same ID.
   */
  async function settleAfterTransferLoss(input: ProjectGitExecution): Promise<ProjectGitActionResult> {
    let observed: ProjectGitActionResult | null;
    try {
      observed = await driver.reconcile(input);
    } catch (error: unknown) {
      console.warn("[collaboration-git] remote outcome unobservable", error instanceof Error ? error.name : "UnknownError");
      throw new AmbiguousProjectGitEffect();
    }
    if (observed) return observed;
    throw new ProjectGitBrokerError("unavailable");
  }

  const driver: ProjectGitDriver & {
    resolveOwnerIdentity(input: { ownerId: string; projectId: string }): Promise<ProjectGitOwnerIdentity>;
    getGitSetup(input: { ownerId: string; projectId: string }): Promise<CollaborationProjectGitSetup>;
    /** Removes the private forge cwd; the driver refuses forge commands afterwards. */
    close(): Promise<void>;
  } = {
    async close() {
      closed = true;
      const pending = forgeCwd;
      forgeCwd = undefined;
      if (!pending) return;
      try {
        await rm(await pending, { recursive: true, force: true });
      } catch (error: unknown) {
        console.warn("[collaboration-git] forge cwd cleanup failed", error instanceof Error ? error.name : "UnknownError");
      }
    },

    async resolveOwnerIdentity(input) {
      await root(input);
      const identity = await ownerIdentity();
      if (identity === "missing") throw new ProjectGitBrokerError("unavailable");
      return identity;
    },

    async getGitSetup(input) {
      try {
        await root(input);
      } catch (error: unknown) {
        console.warn("[collaboration-git] setup root unavailable", error instanceof Error ? error.name : "UnknownError");
        return { identity: { status: "unavailable" }, forgeCredential: { status: "unavailable" } };
      }
      const identity = await (async (): Promise<CollaborationProjectGitSetup["identity"]> => {
        try {
          const resolved = await ownerIdentity();
          return resolved === "missing" ? { status: "missing" } : { status: "ready", label: resolved.label };
        } catch (error: unknown) {
          console.warn("[collaboration-git] identity setup unavailable", error instanceof Error ? error.name : "UnknownError");
          return { status: "unavailable" };
        }
      })();
      let forgeCredential: CollaborationProjectGitSetup["forgeCredential"];
      try {
        await ghCommand(["auth", "status", "--hostname", "github.com"]);
        forgeCredential = { status: "ready" };
      } catch (error: unknown) {
        forgeCredential = isGitExitCode(error, "1") ? { status: "missing" } : { status: "unavailable" };
      }
      return { identity, forgeCredential };
    },

    async run(input: ProjectGitExecution) {
      const cwd = await root(input);
      const request = input.request;
      if (request.type === "status") {
        await gitCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
        return {};
      }
      if (request.type === "diff") {
        await gitCommand(cwd, ["diff", "--no-ext-diff", "--stat", ...(request.baseRef ? [request.baseRef] : [])]);
        return {};
      }
      await requireExpectedHead(cwd, request.expectedHeadSha);
      if (request.type === "commit") {
        try {
          // Contributors stage their exact files in the sandbox; the broker never runs clean filters over new paths.
          await gitCommand(cwd, ["commit", "--no-gpg-sign", "-m", request.message], input.ownerIdentity);
          return { commitSha: await currentHead(cwd) };
        } catch (error: unknown) {
          if (error instanceof ProjectGitBrokerError) throw error;
          console.warn("[collaboration-git] commit failed", error instanceof Error ? error.name : "UnknownError");
          throw new ProjectGitBrokerError("unavailable");
        }
      }
      if (request.type === "push") {
        await requireBranch(cwd, request.branch);
        const remote = await ownerRemote(cwd);
        try {
          await gitCommand(cwd, ["push", "--porcelain", remote.url, `refs/heads/${request.branch}:refs/heads/${request.branch}`], input.ownerIdentity, true);
          return { commitSha: request.expectedHeadSha, remoteBranch: request.branch };
        } catch (error: unknown) {
          const outcome = classifyPushFailure(processFailure(error));
          console.warn(`[collaboration-git] push ${outcome}`, error instanceof Error ? error.name : "UnknownError");
          if (outcome === "failed") throw new ProjectGitBrokerError("unavailable");
          return settleAfterTransferLoss(input);
        }
      }
      await requireBranch(cwd, request.headBranch);
      const remote = await ownerRemote(cwd);
      const observed = await driver.reconcile(input);
      if (observed) return observed;
      try {
        const result = await ghCommand(["pr", "create", "--repo", `${remote.owner}/${remote.repo}`, "--base", request.baseBranch,
          "--head", request.headBranch, "--title", request.title, "--body-file", "-"], request.body ?? "");
        const url = z.url({ protocol: /^https$/ }).max(512).parse(result.stdout.trim());
        return { commitSha: request.expectedHeadSha, remoteBranch: request.headBranch, prUrl: url };
      } catch (error: unknown) {
        const failure = processFailure(error);
        console.warn("[collaboration-git] PR create failed", error instanceof Error ? error.name : "UnknownError");
        // A spawn failure never reached the forge; anything else is settled by observing the forge.
        if (typeof failure.code === "string") throw new ProjectGitBrokerError("unavailable");
        return settleAfterTransferLoss(input);
      }
    },

    async reconcile(input: ProjectGitExecution) {
      const cwd = await root(input);
      const request = input.request;
      if (request.type === "push") {
        const remote = await ownerRemote(cwd);
        const result = await gitCommand(cwd, ["ls-remote", remote.url, `refs/heads/${request.branch}`], input.ownerIdentity, true);
        const sha = result.stdout.trim().split(/\s+/)[0];
        return sha === request.expectedHeadSha ? { commitSha: sha, remoteBranch: request.branch } : null;
      }
      if (request.type === "pr") {
        const remote = await ownerRemote(cwd);
        const result = await ghCommand(["pr", "list", "--repo", `${remote.owner}/${remote.repo}`, "--state", "open",
          "--head", request.headBranch, "--base", request.baseBranch, "--limit", "2", "--json", "url,headRefOid"]);
        const rows = z.array(z.object({ url: z.url({ protocol: /^https$/ }).max(512), headRefOid: GitShaSchema }).strict())
          .max(2).parse(JSON.parse(result.stdout));
        const match = rows.filter((row) => row.headRefOid === request.expectedHeadSha);
        return match.length === 1 ? { commitSha: request.expectedHeadSha, remoteBranch: request.headBranch, prUrl: match[0]!.url } : null;
      }
      return null;
    },
  };
  return driver;
}

export { classifyPushFailure } from "./project-git-process.js";
