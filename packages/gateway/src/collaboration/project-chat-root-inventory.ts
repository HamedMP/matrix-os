import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CanonicalChatExecutionRootRefSchema, type CanonicalChatExecutionRootRef } from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase } from "../chat/database.js";
import { ChatExecutionRootError, type ChatExecutionRootResolver } from "../chat/execution-root.js";

const exec = promisify(execFile);
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ProjectIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const MAX_CHATS = 10_000;

export interface ProjectChatRootInventoryItem {
  chatId: string;
  revision: number;
  executionRoot: CanonicalChatExecutionRootRef;
  fingerprint?: string;
  branch?: string;
  dirty?: boolean;
  readiness: "ready" | "blocked";
  blocker?: "chat_root_unavailable";
}

export class ProjectChatRootInventoryError extends Error {
  constructor() {
    super("Project Chat root inventory is unavailable");
    this.name = "ProjectChatRootInventoryError";
  }
}

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const GIT_COMMON = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

function git(cwd: string, args: string[]) {
  return exec("git", [...GIT_COMMON, ...args], { cwd, env: GIT_ENV, timeout: 10_000, maxBuffer: 64 * 1024 });
}

/**
 * A root must own its repository. A project root's `.git` is a real directory
 * that Git resolves to itself; a registered worktree's `.git` is a regular
 * gitdir file or directory whose common directory is its own project's `.git`.
 * A symlink, or a gitdir that aliases another repository, blocks the Chat root
 * instead of leaking that repository's branch or status.
 */
async function requireOwnRepository(path: string, expected: { kind: "project" } | { kind: "worktree"; projectRoot: string }): Promise<boolean> {
  let meta;
  try {
    meta = await lstat(join(path, ".git"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ProjectChatRootInventoryError();
  }
  if (meta.isSymbolicLink()) throw new ProjectChatRootInventoryError();
  if (expected.kind === "project") {
    if (!meta.isDirectory()) throw new ProjectChatRootInventoryError();
    const absoluteGitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    if (absoluteGitDir !== join(await realpath(path), ".git")) throw new ProjectChatRootInventoryError();
    return true;
  }
  if (!meta.isFile() && !meta.isDirectory()) throw new ProjectChatRootInventoryError();
  const commonDir = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  if (await realpath(commonDir) !== join(await realpath(expected.projectRoot), ".git")) throw new ProjectChatRootInventoryError();
  return true;
}

async function inspectGitRoot(
  path: string,
  expected: { kind: "project" } | { kind: "worktree"; projectRoot: string },
): Promise<{ branch?: string; dirty?: boolean }> {
  try {
    // Non-Git projects can still be shared. The Git setup state is separately unavailable.
    if (!(await requireOwnRepository(path, expected))) return {};
    const [branch, status] = await Promise.all([
      git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    return { branch: branch.stdout.trim(), dirty: status.stdout.length > 0 };
  } catch (error: unknown) {
    if (!(error instanceof ProjectChatRootInventoryError)) {
      console.warn("[collaboration-chat-roots] Git inspection failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new ProjectChatRootInventoryError();
  }
}

/** Reads the most recent canonical turn root for every project Chat; no host path escapes this module. */
export function createProjectChatRootInventory(options: {
  db: Kysely<ChatDatabase>;
  executionRoots: Pick<ChatExecutionRootResolver, "resolve">;
}) {
  return {
    async list(input: { ownerId: string; projectId: string }): Promise<ProjectChatRootInventoryItem[]> {
      const ownerId = ActorIdSchema.parse(input.ownerId);
      const projectId = ProjectIdSchema.parse(input.projectId);
      const chats = await options.db.selectFrom("chats")
        .select(["id", "revision"])
        .where("owner_type", "=", "personal")
        .where("owner_id", "=", ownerId)
        .where("project_id", "=", projectId)
        .orderBy("id", "asc")
        .limit(MAX_CHATS + 1)
        .execute();
      if (chats.length > MAX_CHATS) throw new ProjectChatRootInventoryError();

      const [queued, runs] = await Promise.all([
        options.db.selectFrom("chat_queued_turns as turn")
          .innerJoin("chats as chat", "chat.id", "turn.chat_id")
          .distinctOn("turn.chat_id")
          .select(["turn.chat_id", "turn.execution_root", "turn.updated_at", "turn.id"])
          .where("chat.owner_type", "=", "personal")
          .where("chat.owner_id", "=", ownerId)
          .where("chat.project_id", "=", projectId)
          .where("turn.execution_root", "is not", null)
          .orderBy("turn.chat_id", "asc")
          .orderBy("turn.updated_at", "desc")
          .orderBy("turn.id", "desc")
          .execute(),
        options.db.selectFrom("chat_runs as run")
          .innerJoin("chats as chat", "chat.id", "run.chat_id")
          .distinctOn("run.chat_id")
          .select(["run.chat_id", "run.execution_root", "run.updated_at", "run.id"])
          .where("chat.owner_type", "=", "personal")
          .where("chat.owner_id", "=", ownerId)
          .where("chat.project_id", "=", projectId)
          .where("run.execution_root", "is not", null)
          .orderBy("run.chat_id", "asc")
          .orderBy("run.updated_at", "desc")
          .orderBy("run.id", "desc")
          .execute(),
      ]);
      const selected = new Map<string, { root: unknown; at: number }>();
      for (const row of [...queued, ...runs]) {
        const at = new Date(row.updated_at).getTime();
        if (!selected.has(row.chat_id) || selected.get(row.chat_id)!.at < at) {
          selected.set(row.chat_id, { root: row.execution_root, at });
        }
      }

      return Promise.all(chats.map(async (chat): Promise<ProjectChatRootInventoryItem> => {
        const rootInput = selected.get(chat.id)?.root ?? { kind: "project", projectId };
        const parsed = CanonicalChatExecutionRootRefSchema.safeParse(rootInput);
        const fallback = { kind: "project" as const, projectId };
        if (!parsed.success || parsed.data.projectId !== projectId) {
          return { chatId: chat.id, revision: Number(chat.revision), executionRoot: fallback, readiness: "blocked", blocker: "chat_root_unavailable" };
        }
        try {
          const resolved = await options.executionRoots.resolve({ type: "personal", ownerId }, parsed.data);
          const git = await inspectGitRoot(resolved.primaryWorkspaceRoot, parsed.data.kind === "project"
            ? { kind: "project" }
            : { kind: "worktree", projectRoot: (await options.executionRoots.resolve({ type: "personal", ownerId }, { kind: "project", projectId })).primaryWorkspaceRoot });
          return {
            chatId: chat.id,
            revision: Number(chat.revision),
            executionRoot: parsed.data,
            fingerprint: resolved.fingerprint,
            ...git,
            readiness: "ready",
          };
        } catch (error: unknown) {
          if (!(error instanceof ChatExecutionRootError || error instanceof ProjectChatRootInventoryError)) throw error;
          return { chatId: chat.id, revision: Number(chat.revision), executionRoot: parsed.data, readiness: "blocked", blocker: "chat_root_unavailable" };
        }
      }));
    },
  };
}
