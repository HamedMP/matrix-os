/**
 * The board's session ports over the real gateway services (spec 2699
 * sections 3 and 4): the worktree and project managers, the canonical chat
 * service and owner database, the terminal runtime socket client, and `git`/`gh`
 * run without a shell, with timeouts, in the owner's GitHub environment.
 */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import type { CanonicalOwnerScope, TerminalWorkspace } from "@matrix-os/contracts";
import {
  ProjectIdSchema, TASK_SESSION_TOKEN_ENV, TaskIdSchema, type TaskAgentStatus, type TaskPullRequest,
} from "@matrix-os/contracts/project-tasks";
import type { ChatDatabase } from "../chat/database.js";
import type { CanonicalChatRouteService } from "../chat/routes.js";
import { githubOwnerEnvironment } from "../github-owner-environment.js";
import type { createProjectManager } from "../project-manager.js";
import type { OwnerScope } from "../state-ops.js";
import type { createWorktreeManager } from "../worktree-manager.js";
import type { TaskSessionCredentials } from "../project-tasks/session-credentials.js";
import {
  TaskPortUnavailableError, type ChatPort, type GitPort, type ProjectRootPort, type PullRequestLookup, type PullRequestPort,
  type TaskSessionPorts, type TerminalPort, type WorktreePort,
} from "../project-tasks/session-ports.js";

export type TaskCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export const TASK_COMMAND_TIMEOUTS = { git: 10_000, gh: 10_000, push: 30_000 } as const;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const defaultRunCommand: TaskCommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd, timeout: options.timeout, encoding: "utf-8", maxBuffer: MAX_OUTPUT_BYTES, env: options.env,
  });
  return { stdout, stderr };
};

/** Fixed launch commands per harness; the terminal never runs anything built from task text. */
const HARNESS_COMMANDS: Record<string, string> = { claude: "claude", codex: "codex", opencode: "opencode", pi: "pi" };

type TerminalRuntime = {
  ensureWorkspace(input: { projectId?: string }): Promise<TerminalWorkspace>;
  createTab(workspaceId: string, input: { tabId?: string; name: string; cwd: string; accessScope?: "owner"; command?: string[] }): Promise<{ id: string }>;
  listWorkspaces(): Promise<TerminalWorkspace[]>;
  listAgentStatuses(): Promise<Array<{ ref: { workspaceId: string; tabId: string }; status: TaskAgentStatus }>>;
};

const GhCheckSchema = z.object({
  status: z.string().max(40).nullish(),
  conclusion: z.string().max(40).nullish(),
  state: z.string().max(40).nullish(),
}).passthrough();
const GhPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().max(500).startsWith("https://"),
  state: z.string().max(20),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().max(40).nullish(),
  statusCheckRollup: z.array(GhCheckSchema).max(1_000).nullish(),
});

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
  return `${error.message}\n${stderr}`;
}

const FAILED_CHECK = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/** GitHub's check runs (status/conclusion) and commit statuses (state) rolled up to one word. */
export function checksRollup(checks: ReadonlyArray<z.infer<typeof GhCheckSchema>>): TaskPullRequest["checks"] {
  if (checks.length === 0) return "none";
  const verdicts = checks.map((check): TaskPullRequest["checks"] => {
    const conclusion = (check.conclusion ?? "").toUpperCase();
    const state = (check.state ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();
    if (FAILED_CHECK.has(conclusion) || FAILED_CHECK.has(state)) return "failing";
    if (conclusion || state === "SUCCESS") return "passing";
    if (state === "PENDING" || state === "EXPECTED" || (status && status !== "COMPLETED")) return "pending";
    return "passing";
  });
  if (verdicts.includes("failing")) return "failing";
  return verdicts.includes("pending") ? "pending" : "passing";
}

export function toTaskPullRequest(value: unknown): TaskPullRequest | null {
  const parsed = GhPullRequestSchema.safeParse(value);
  if (!parsed.success) return null;
  const pr = parsed.data;
  const upper = pr.state.toUpperCase();
  const state: TaskPullRequest["state"] = upper === "MERGED" ? "merged" : upper === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const decision = (pr.reviewDecision ?? "").toUpperCase();
  const review: TaskPullRequest["review"] = decision === "APPROVED" ? "approved"
    : decision === "CHANGES_REQUESTED" ? "changes_requested" : decision === "REVIEW_REQUIRED" ? "review_required" : "none";
  return { number: pr.number, url: pr.url, state, checks: checksRollup(pr.statusCheckRollup ?? []), review };
}

function chatOwner(ownerScope: OwnerScope): CanonicalOwnerScope {
  // Organization boards come with sharing (stack 2); until then only personal chats are reachable.
  if (ownerScope.type !== "user") throw new TaskPortUnavailableError("chats", "organization_owner");
  return { type: "personal", ownerId: ownerScope.id };
}

export function chatRunAgentStatus(status: string): TaskAgentStatus {
  if (status === "running" || status === "accepted") return "working";
  if (status === "waiting_for_input" || status === "waiting_for_approval") return "blocked";
  if (status === "failed") return "error";
  return status === "completed" ? "done" : "idle";
}

function terminalRef(workspaceId: string, tabId: string): string {
  return `term.${workspaceId}.${tabId}`;
}

export interface TaskSessionPortOptions {
  homePath: string;
  projectManager: Pick<ReturnType<typeof createProjectManager>, "resolveProjectWorkingDirectory" | "getCodeMetadata">;
  worktreeManager: Pick<ReturnType<typeof createWorktreeManager>, "createWorktree" | "getWorktree">;
  /** The canonical chat service and the owner chat database; null without the owner database. */
  chats: { service: Pick<CanonicalChatRouteService, "create" | "admitTurn">; db: Kysely<ChatDatabase> } | null;
  terminalRuntime: TerminalRuntime;
  /** Signs each task tab's credential; the board binds local-token callers only from it. */
  sessionCredentials: Pick<TaskSessionCredentials, "issue">;
  runCommand?: TaskCommandRunner;
}

export function createTaskSessionPorts(options: TaskSessionPortOptions): TaskSessionPorts {
  const homePath = resolve(options.homePath);
  const run = options.runCommand ?? defaultRunCommand;
  const env = githubOwnerEnvironment(homePath);

  const worktrees: WorktreePort = {
    async ensure(input) {
      const result = await options.worktreeManager.createWorktree({ ...input, createBranch: true });
      if (!result.ok) throw new TaskPortUnavailableError("worktrees", result.error.code);
      return { id: result.worktree.id, path: result.worktree.path, branch: result.worktree.currentBranch };
    },
    async get(input) {
      const result = await options.worktreeManager.getWorktree(input.projectSlug, input.worktreeId, input.ownerScope);
      if (!result.ok) {
        if (result.status === 404 || result.status === 400) return null;
        throw new TaskPortUnavailableError("worktrees", result.error.code);
      }
      return { id: result.worktree.id, path: result.worktree.path, branch: result.worktree.currentBranch };
    },
  };

  const projectRoot: ProjectRootPort = {
    async resolve(project, ownerScope) {
      const path = await options.projectManager.resolveProjectWorkingDirectory(project);
      if (!path) return null;
      const metadata = await options.projectManager.getCodeMetadata(project.slug, ownerScope);
      if (!metadata.ok) throw new TaskPortUnavailableError("projectRoot", metadata.error.code);
      return { path, git: metadata.isGitRepository };
    },
  };

  const git: GitPort = {
    async summary({ cwd, defaultBranch }) {
      const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd, timeout: TASK_COMMAND_TIMEOUTS.git, env });
      const changedFiles = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
      const head = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: TASK_COMMAND_TIMEOUTS.git, env })).stdout.trim();
      let ahead = 0;
      let behind = 0;
      for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
        try {
          const counts = await run("git", ["rev-list", "--left-right", "--count", `${base}...HEAD`, "--"], { cwd, timeout: TASK_COMMAND_TIMEOUTS.git, env });
          const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
          behind = Math.max(0, Number.parseInt(behindText ?? "0", 10) || 0);
          ahead = Math.max(0, Number.parseInt(aheadText ?? "0", 10) || 0);
          break;
        } catch (error: unknown) {
          // A missing base ref is expected for repositories without a remote; try the local branch next.
          console.info("[project-tasks] divergence base unavailable", base === defaultBranch ? "local" : "origin", error instanceof Error ? error.name : typeof error);
        }
      }
      return { branch: head && head !== "HEAD" ? head : null, dirty: changedFiles > 0, ahead, behind, changedFiles };
    },
  };

  async function findPullRequest(cwd: string, branch: string): Promise<PullRequestLookup> {
    try {
      const result = await run("gh", [
        "pr", "view", branch, "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup",
      ], { cwd, timeout: TASK_COMMAND_TIMEOUTS.gh, env });
      const pullRequest = toTaskPullRequest(JSON.parse(result.stdout));
      return pullRequest ? { status: "ok", pullRequest } : { status: "unavailable" };
    } catch (error: unknown) {
      if (/no pull requests? found/i.test(errorText(error))) return { status: "ok", pullRequest: null };
      // Missing, signed-out or slow `gh`: the board shows the card without PR state.
      console.warn("[project-tasks] gh pr view unavailable", error instanceof Error ? error.name : typeof error);
      return { status: "unavailable" };
    }
  }

  const pullRequests: PullRequestPort = {
    find: ({ cwd, branch }) => findPullRequest(cwd, branch),
    async open({ cwd, branch, baseBranch, title, body, draft }) {
      try {
        await run("git", ["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd, timeout: TASK_COMMAND_TIMEOUTS.push, env });
      } catch (error: unknown) {
        console.warn("[project-tasks] git push failed", error instanceof Error ? error.name : typeof error);
        return { status: "unavailable" };
      }
      const existing = await findPullRequest(cwd, branch);
      if (existing.status !== "ok" || existing.pullRequest) return existing;
      try {
        await run("gh", [
          "pr", "create", `--head=${branch}`, `--base=${baseBranch}`, `--title=${title}`, `--body=${body}`, ...(draft ? ["--draft"] : []),
        ], { cwd, timeout: TASK_COMMAND_TIMEOUTS.gh, env });
      } catch (error: unknown) {
        console.warn("[project-tasks] gh pr create failed", error instanceof Error ? error.name : typeof error);
        return { status: "unavailable" };
      }
      return findPullRequest(cwd, branch);
    },
  };

  const chatsUnavailable = () => new TaskPortUnavailableError("chats", "owner_database_unavailable");
  const chats: ChatPort = {
    async create(ownerScope, input) {
      if (!options.chats) throw chatsUnavailable();
      const { worktreeId, ...request } = input;
      const record = await options.chats.service.create(chatOwner(ownerScope), request, worktreeId ? { defaultWorktreeId: worktreeId } : undefined);
      return { id: record.chat.id, revision: record.chat.revision };
    },
    async admitFirstTurn(input) {
      if (!options.chats) throw chatsUnavailable();
      await options.chats.service.admitTurn(input.principal, chatOwner(input.ownerScope), input.chatId, {
        clientRequestId: input.clientRequestId,
        baseRevision: input.baseRevision,
        parts: [{ type: "text", text: input.text }],
        selection: input.selection,
        interactionMode: "default",
        permissionMode: "default",
        executionRoot: input.executionRoot,
      });
    },
    async describe(ownerScope, chatIds) {
      if (!options.chats) throw chatsUnavailable();
      if (chatIds.length === 0) return [];
      const owner = chatOwner(ownerScope);
      const rows = await options.chats.db.selectFrom("chats").select(["id", "title", "project_id"])
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .where("lifecycle", "=", "active").where("id", "in", [...chatIds]).limit(chatIds.length).execute();
      return rows.map((row) => ({ id: row.id, title: row.title, projectId: row.project_id }));
    },
    async listForProject(ownerScope, projectId, limit) {
      if (!options.chats) throw chatsUnavailable();
      const owner = chatOwner(ownerScope);
      const rows = await options.chats.db.selectFrom("chats").select(["id", "title", "project_id"])
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .where("lifecycle", "=", "active").where("project_id", "=", projectId)
        .orderBy("activity_at", "desc").orderBy("id", "desc").limit(limit).execute();
      return rows.map((row) => ({ id: row.id, title: row.title, projectId: row.project_id }));
    },
    async statuses(ownerScope, chatIds) {
      if (!options.chats || chatIds.length === 0) return {};
      const owner = chatOwner(ownerScope);
      const rows = await options.chats.db.selectFrom("chat_runs as run")
        .innerJoin("chats as chat", "chat.id", "run.chat_id")
        .select(["run.chat_id", "run.status"])
        .distinctOn("run.chat_id")
        .where("chat.owner_type", "=", owner.type).where("chat.owner_id", "=", owner.ownerId)
        .where("run.chat_id", "in", [...chatIds])
        .orderBy("run.chat_id").orderBy("run.created_at", "desc").orderBy(sql`run.id`, "desc")
        .limit(chatIds.length).execute();
      return Object.fromEntries(rows.map((row) => [row.chat_id, chatRunAgentStatus(row.status)]));
    },
  };

  const terminals: TerminalPort = {
    async ensureWorkspace(projectId) {
      const workspace = await options.terminalRuntime.ensureWorkspace({ projectId: ProjectIdSchema.parse(projectId) });
      return { workspaceId: workspace.id };
    },
    async createTab(input) {
      const target = resolve(input.cwd);
      const cwd = relative(homePath, target);
      if (cwd.startsWith(`..${sep}`) || cwd === ".." || isAbsolute(cwd)) throw new TaskPortUnavailableError("terminals", "cwd_outside_home");
      // Environment comes only from server-validated ids; the shell script is a constant.
      const taskId = TaskIdSchema.parse(input.env.MATRIX_TASK_ID);
      const projectId = ProjectIdSchema.parse(input.env.MATRIX_PROJECT_ID);
      const credential = await options.sessionCredentials.issue({ workspaceId: input.workspaceId, tabId: input.tabId, projectId, taskId });
      const assignments = [`MATRIX_TASK_ID=${taskId}`, `MATRIX_PROJECT_ID=${projectId}`, `${TASK_SESSION_TOKEN_ENV}=${credential}`];
      const harness = input.harness ? HARNESS_COMMANDS[input.harness] : undefined;
      if (input.harness && !harness) throw new TaskPortUnavailableError("terminals", "unsupported_harness");
      const command = harness
        ? ["env", ...assignments, "sh", "-lc", 'exec "$0"', harness]
        : ["env", ...assignments, "sh", "-lc", 'exec "${SHELL:-/bin/sh}" -l'];
      const tab = await options.terminalRuntime.createTab(input.workspaceId, {
        tabId: input.tabId, name: input.name.slice(0, 120), cwd, accessScope: "owner", command,
      });
      // The credential signs the requested tab; a runtime that picked another id has a tab it cannot prove.
      if (tab.id !== input.tabId) throw new TaskPortUnavailableError("terminals", "tab_id_mismatch");
      return { tabId: tab.id };
    },
    async listForProject(projectId) {
      const workspaces = await options.terminalRuntime.listWorkspaces();
      return workspaces
        .filter((workspace) => workspace.scope === "project" && workspace.projectId === projectId)
        .flatMap((workspace) => workspace.tabs
          .filter((tab) => tab.accessScope !== "chat" && ["starting", "running", "idle"].includes(tab.status))
          .map((tab) => ({ workspaceId: workspace.id, tabId: tab.id, name: tab.name })))
        .slice(0, 500);
    },
    async existingRefs(projectId) {
      const workspaces = await options.terminalRuntime.listWorkspaces();
      return workspaces
        .filter((workspace) => workspace.scope === "project" && workspace.projectId === projectId)
        .flatMap((workspace) => workspace.tabs.map((tab) => terminalRef(workspace.id, tab.id)))
        .slice(0, 2_000);
    },
    async statuses() {
      const entries = await options.terminalRuntime.listAgentStatuses();
      return Object.fromEntries(entries.map((entry) => [terminalRef(entry.ref.workspaceId, entry.ref.tabId), entry.status]));
    },
  };

  return { worktrees, projectRoot, git, chats, terminals, pullRequests };
}
