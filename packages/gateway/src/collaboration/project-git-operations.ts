import { sql, type ColumnType, type Transaction } from "kysely";
import type { CollaborationGitActionRequest, CollaborationProjectGitSetup } from "@matrix-os/contracts";
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
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { githubDeveloperSshCommand } from "../github-developer-status.js";
import { githubOwnerEnvironment } from "../github-owner-environment.js";
import { validateGitHubUrl } from "../project-manager.js";
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

type GitCommandResult = { stdout: string; stderr: string };

function gitEnvironment(identity?: ProjectGitOwnerIdentity): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
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

async function gitCommand(cwd: string, args: string[], identity?: ProjectGitOwnerIdentity): Promise<GitCommandResult> {
  return exec("git", [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    cwd,
    env: gitEnvironment(identity),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

/**
 * Identity discovery honours the owner's ordinary Git configuration precedence
 * (system, then global, then local), because the broker commits as the owner and
 * most owners configure `user.name`/`user.email` once in their global config.
 * Mutating commands stay hermetic: they keep global and system config disabled
 * and receive this resolved identity through the GIT_AUTHOR and GIT_COMMITTER
 * environment variables.
 */
async function gitIdentityValue(cwd: string, key: "user.name" | "user.email"): Promise<string> {
  const { stdout } = await exec("git", [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "config", "--get", key,
  ], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/nonexistent",
      ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

async function ghCommand(homePath: string, args: string[]): Promise<GitCommandResult> {
  return exec("gh", args, {
    cwd: homePath,
    env: { ...githubOwnerEnvironment(homePath), GH_PROMPT_DISABLED: "1" },
    timeout: REMOTE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

async function readGitMetadata(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new ProjectGitBrokerError("unavailable");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead !== stat.size) throw new ProjectGitBrokerError("unavailable");
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

async function sourceObjects(root: string): Promise<{ objects: string; shallow?: string }> {
  const { stdout } = await gitCommand(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"]);
  const [gitDir, commonDir, extra] = stdout.replace(/\n$/, "").split("\n");
  if (!gitDir || !commonDir || extra !== undefined || !isAbsolute(gitDir) || !isAbsolute(commonDir)
    || await realpath(gitDir) !== gitDir || await realpath(commonDir) !== commonDir) {
    throw new ProjectGitBrokerError("unavailable");
  }
  const checkoutGit = join(root, ".git");
  if (gitDir !== checkoutGit || commonDir !== checkoutGit) {
    // A linked worktree is valid only if the common repository recognizes this
    // checkout. Its writable .git pointer alone cannot grant object access.
    if (dirname(gitDir) !== join(commonDir, "worktrees")) throw new ProjectGitBrokerError("unavailable");
    const backref = await readGitMetadata(join(gitDir, "gitdir"), 4096);
    if (backref.replace(/\r?\n$/, "") !== checkoutGit) throw new ProjectGitBrokerError("unavailable");
  }
  const objects = join(commonDir, "objects");
  if (await realpath(objects) !== objects) throw new ProjectGitBrokerError("unavailable");
  try {
    const shallow = await readGitMetadata(join(commonDir, "shallow"), 64 * 1024);
    if (!/^(?:[0-9a-f]{40}\n)*$/.test(shallow)) throw new ProjectGitBrokerError("unavailable");
    return { objects, shallow };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { objects };
    throw error;
  }
}

async function remoteGit(
  homePath: string,
  args: string[],
  source?: { objects: string; shallow?: string },
): Promise<GitCommandResult> {
  const env = {
    ...githubOwnerEnvironment(homePath),
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GIT_SSH_COMMAND: githubDeveloperSshCommand(homePath),
  };
  const cwd = await mkdtemp(join(tmpdir(), "matrix-collaboration-git-"));
  try {
    await exec("git", ["init", "--bare", "--template=", "."], {
      cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    if (source) {
      // Borrow the checkout's objects without loading its Git or transport configuration.
      await writeFile(join(cwd, "objects", "info", "alternates"), `${source.objects}\n`, { flag: "wx" });
      if (source.shallow) await writeFile(join(cwd, "shallow"), source.shallow, { flag: "wx" });
    }
    try {
      return await exec("git", [
        "--no-replace-objects",
        "-c", "core.hooksPath=/dev/null",
        "-c", "credential.helper=",
        "-c", "credential.helper=!gh auth git-credential",
        ...args,
      ], { cwd, env, timeout: REMOTE_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    } catch (error: unknown) {
      if (!source) throw error;
      console.warn("[collaboration-git] push outcome ambiguous", error instanceof Error ? error.name : "UnknownError");
      throw new AmbiguousProjectGitEffect();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn("[collaboration-git] transport cleanup failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
}

async function requireRepositoryRoot(path: string): Promise<string> {
  const resolved = await realpath(path);
  let top: string;
  try {
    top = (await gitCommand(resolved, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error: unknown) {
    console.warn("[collaboration-git] repository unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
  if (await realpath(top) !== resolved) throw new ProjectGitBrokerError("unavailable");
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
  async function readOrigin(key: "remote.origin.pushurl" | "remote.origin.url"): Promise<string | undefined> {
    try {
      const result = await gitCommand(root, ["config", "--local", "--no-includes", "--null", "--get-all", key]);
      return result.stdout.split("\0", 1)[0];
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === 1) return undefined;
      throw error;
    }
  }

  let value: string;
  try {
    value = (await readOrigin("remote.origin.pushurl")) ?? (await readOrigin("remote.origin.url")) ?? "";
  } catch (error: unknown) {
    console.warn("[collaboration-git] remote unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new ProjectGitBrokerError("unavailable");
  }
  const parsed = validateGitHubUrl(value);
  if (
    !parsed.ok
    || (!value.startsWith("https://github.com/") && !value.startsWith("git@github.com:"))
  ) {
    throw new ProjectGitBrokerError("unavailable");
  }
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    url: value.startsWith("git@")
      ? `git@github.com:${parsed.owner}/${parsed.repo}.git`
      : `https://github.com/${parsed.owner}/${parsed.repo}.git`,
  };
}

async function requireExpectedHead(root: string, expectedHeadSha: string): Promise<void> {
  if (await currentHead(root) !== expectedHeadSha) throw new ProjectGitBrokerError("conflict");
}

async function requireBranch(root: string, expected: string): Promise<void> {
  const branch = (await gitCommand(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (branch !== expected) throw new ProjectGitBrokerError("conflict");
}

/** Git applies whitespace cleanup to `-m` messages, so compare on the same normalised form. */
function normalizeCommitMessage(value: string): string {
  return value.split("\n").map((line) => line.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");
}

/**
 * A commit failure is definite only when HEAD is still the revision the request
 * expected. A moved or unreadable HEAD means the effect may already have landed,
 * so the operation must settle as unresolved and be reconciled rather than
 * recorded as a terminal failure.
 */
async function commitFailure(root: string, expectedHeadSha: string): Promise<Error> {
  try {
    if (await currentHead(root) === expectedHeadSha) return new ProjectGitBrokerError("unavailable");
  } catch (error: unknown) {
    if (!(error instanceof ProjectGitBrokerError)) throw error;
    console.warn("[collaboration-git] commit outcome unverifiable", error.name);
  }
  return new AmbiguousProjectGitEffect();
}

/** Non-null only when the tip proves this operation's commit landed: our parent, our message, the owner's identity. */
async function observeCommit(
  root: string,
  request: Extract<CollaborationGitActionRequest, { type: "commit" }>,
  identity: ProjectGitOwnerIdentity,
): Promise<ProjectGitActionResult | null> {
  const head = await currentHead(root);
  if (head === request.expectedHeadSha) return null;
  const tip = await gitCommand(root, ["log", "--max-count=1", "--format=%H%x00%P%x00%cn%x00%ce%x00%B", head]);
  const [sha, parents, committerName, committerEmail, ...body] = tip.stdout.split("\0");
  if (sha !== head) return null;
  if ((parents ?? "").trim() !== request.expectedHeadSha) return null;
  if (committerName !== identity.name || committerEmail !== identity.email) return null;
  if (normalizeCommitMessage(body.join("\0")) !== normalizeCommitMessage(request.message)) return null;
  return { commitSha: GitShaSchema.parse(sha) };
}

/** Host-side Git/forge driver. Credentials remain in the owner host and never enter the scope runtime. */
export function createProjectGitDriver(options: {
  homePath?: string;
  resolveProjectRoot(input: { ownerId: string; projectId: string }): Promise<string>;
}) {
  const homePath = options.homePath ?? homedir();
  async function root(input: { ownerId: string; projectId: string }) {
    return requireRepositoryRoot(await options.resolveProjectRoot(input));
  }

  const driver: ProjectGitDriver & {
    resolveOwnerIdentity(input: { ownerId: string; projectId: string }): Promise<ProjectGitOwnerIdentity>;
    getGitSetup(input: { ownerId: string; projectId: string }): Promise<CollaborationProjectGitSetup>;
  } = {
    async resolveOwnerIdentity(input) {
      const cwd = await root(input);
      try {
        const [name, email] = await Promise.all([
          gitIdentityValue(cwd, "user.name"),
          gitIdentityValue(cwd, "user.email"),
        ]);
        const parsedName = GitIdentityNameSchema.parse(name);
        const parsedEmail = GitIdentityEmailSchema.parse(email);
        return { name: parsedName, email: parsedEmail, label: `${parsedName} <${parsedEmail}>` };
      } catch (error: unknown) {
        console.warn("[collaboration-git] owner identity unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new ProjectGitBrokerError("unavailable");
      }
    },

    async getGitSetup(input) {
      let cwd: string;
      try {
        cwd = await root(input);
      } catch (error: unknown) {
        console.warn("[collaboration-git] setup root unavailable", error instanceof Error ? error.name : "UnknownError");
        return { identity: { status: "unavailable" }, forgeCredential: { status: "unavailable" } };
      }
      const identity = await (async (): Promise<CollaborationProjectGitSetup["identity"]> => {
        try {
          const [name, email] = await Promise.all([
            gitIdentityValue(cwd, "user.name"),
            gitIdentityValue(cwd, "user.email"),
          ]);
          return { status: "ready", label: `${GitIdentityNameSchema.parse(name)} <${GitIdentityEmailSchema.parse(email)}>` };
        } catch (error: unknown) {
          if (error instanceof Error && "code" in error && String((error as NodeJS.ErrnoException).code) === "1") {
            return { status: "missing" };
          }
          console.warn("[collaboration-git] identity setup unavailable", error instanceof Error ? error.name : "UnknownError");
          return { status: "unavailable" };
        }
      })();
      let forgeCredential: CollaborationProjectGitSetup["forgeCredential"];
      try {
        await ghCommand(homePath, ["auth", "status", "--hostname", "github.com"]);
        forgeCredential = { status: "ready" };
      } catch (error: unknown) {
        forgeCredential = error instanceof Error && "code" in error && String((error as NodeJS.ErrnoException).code) === "1"
          ? { status: "missing" } : { status: "unavailable" };
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
        } catch (error: unknown) {
          console.warn("[collaboration-git] commit failed", error instanceof Error ? error.name : "UnknownError");
          throw await commitFailure(cwd, request.expectedHeadSha);
        }
        try {
          return { commitSha: await currentHead(cwd) };
        } catch (error: unknown) {
          // The commit command succeeded, so a HEAD read failure leaves the effect unresolved, never failed.
          if (!(error instanceof ProjectGitBrokerError)) throw error;
          console.warn("[collaboration-git] commit landed with an unreadable HEAD", error.name);
          throw new AmbiguousProjectGitEffect();
        }
      }
      if (request.type === "push") {
        await requireBranch(cwd, request.branch);
        const remote = await ownerRemote(cwd);
        const source = await sourceObjects(cwd);
        await remoteGit(homePath, ["push", "--porcelain", "--", remote.url, `${request.expectedHeadSha}:refs/heads/${request.branch}`], source);
        return { commitSha: request.expectedHeadSha, remoteBranch: request.branch };
      }
      await requireBranch(cwd, request.headBranch);
      const remote = await ownerRemote(cwd);
      const observed = await driver.reconcile(input);
      if (observed) return observed;
      try {
        const result = await ghCommand(homePath, ["pr", "create", "--repo", `${remote.owner}/${remote.repo}`, "--base", request.baseBranch,
          "--head", request.headBranch, "--title", request.title, "--body", request.body ?? ""]);
        const url = z.url({ protocol: /^https$/ }).max(512).parse(result.stdout.trim());
        return { commitSha: request.expectedHeadSha, remoteBranch: request.headBranch, prUrl: url };
      } catch (error: unknown) {
        console.warn("[collaboration-git] PR outcome ambiguous", error instanceof Error ? error.name : "UnknownError");
        throw new AmbiguousProjectGitEffect();
      }
    },

    async reconcile(input: ProjectGitExecution) {
      const cwd = await root(input);
      const request = input.request;
      if (request.type === "commit") {
        return observeCommit(cwd, request, input.ownerIdentity);
      }
      if (request.type === "push") {
        const remote = await ownerRemote(cwd);
        const ref = `refs/heads/${request.branch}`;
        const result = await remoteGit(homePath, ["ls-remote", "--refs", "--", remote.url, ref]);
        return result.stdout.trimEnd() === `${request.expectedHeadSha}\t${ref}`
          ? { commitSha: request.expectedHeadSha, remoteBranch: request.branch }
          : null;
      }
      if (request.type === "pr") {
        const remote = await ownerRemote(cwd);
        const result = await ghCommand(homePath, ["pr", "list", "--repo", `${remote.owner}/${remote.repo}`, "--state", "open",
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
