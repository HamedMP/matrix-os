import { execFile } from "node:child_process";
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

type GitProbe =
  | { status: "ok"; stdout: string }
  /** `code` is the process exit status, or null when the process never produced one. */
  | { status: "exit"; code: number | null };

async function probeGitRoot(path: string, args: string[]): Promise<GitProbe> {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const common = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
  try {
    const { stdout } = await exec("git", [...common, ...args], {
      cwd: path, env, timeout: 10_000, maxBuffer: 64 * 1024,
    });
    return { status: "ok", stdout };
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? Number((error as NodeJS.ErrnoException).code) : Number.NaN;
    if (Number.isInteger(code)) return { status: "exit", code };
    console.warn("[collaboration-project] Chat root Git probe failed", error instanceof Error ? error.name : "UnknownError");
    return { status: "exit", code: null };
  }
}

async function inspectGitRoot(path: string): Promise<{ branch?: string; dirty?: boolean }> {
  const [branch, status] = await Promise.all([
    probeGitRoot(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    probeGitRoot(path, ["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  // Non-Git projects can still be shared. The Git setup state is separately unavailable.
  if (status.status === "exit" && status.code === 128) return {};
  if (status.status !== "ok") throw new ProjectChatRootInventoryError();
  // A detached HEAD is a valid root: `symbolic-ref` exits 1 because there is no branch, not because the root is broken.
  if (branch.status === "exit" && branch.code !== 1) throw new ProjectChatRootInventoryError();
  const name = branch.status === "ok" ? branch.stdout.trim() : "";
  return { ...(name ? { branch: name } : {}), dirty: status.stdout.length > 0 };
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
          const git = await inspectGitRoot(resolved.primaryWorkspaceRoot);
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
