/**
 * The subsystems "Start work" reaches (spec 2699 sections 3 and 4), as small
 * ports injected into the board. The gateway wiring implements them over the
 * worktree manager, project manager, canonical chat service, terminal runtime
 * and `gh`; tests use fakes. Every port is resolved when the board is built.
 */
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { TaskAgentStatus, TaskPullRequest } from "@matrix-os/contracts/project-tasks";
import type { ProjectConfig } from "../project-manager.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { OwnerScope } from "../state-ops.js";

export interface TaskWorktree {
  id: string;
  /** Absolute checkout path. */
  path: string;
  branch: string;
}

export interface WorktreePort {
  /** Create the worktree for a branch (creating the branch from the default branch), or return the existing one. */
  ensure(input: { projectSlug: string; ownerScope: OwnerScope; branch: string }): Promise<TaskWorktree>;
  get(input: { projectSlug: string; ownerScope: OwnerScope; worktreeId: string }): Promise<TaskWorktree | null>;
}

export interface ProjectRootPort {
  /** The project's own folder, and whether it is a git repository; null when it is not usable. */
  resolve(project: ProjectConfig, ownerScope: OwnerScope): Promise<{ path: string; git: boolean } | null>;
}

export interface GitSummary {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  changedFiles: number;
}

export interface GitPort {
  /** Working-tree state and divergence from `defaultBranch`, with command timeouts. */
  summary(input: { cwd: string; defaultBranch: string }): Promise<GitSummary>;
}

export interface ProjectChat {
  id: string;
  title: string;
  projectId: string | null;
}

export interface ChatPort {
  /** `worktreeId` becomes the chat's default root, so turns without one (the composer) still run in the task worktree. */
  create(ownerScope: OwnerScope, input: { clientRequestId: string; title: string; projectId: string; worktreeId?: string }): Promise<{ id: string; revision: number }>;
  /** Admit the chat's first turn; idempotent on `clientRequestId`. */
  admitFirstTurn(input: {
    principal: RequestPrincipal;
    ownerScope: OwnerScope;
    chatId: string;
    baseRevision: number;
    clientRequestId: string;
    text: string;
    selection: CanonicalChatModelSelection;
    executionRoot: { kind: "project"; projectId: string } | { kind: "worktree"; projectId: string; worktreeId: string };
  }): Promise<void>;
  /** The owner's chats among `chatIds`; unknown or foreign ids are left out. */
  describe(ownerScope: OwnerScope, chatIds: readonly string[]): Promise<ProjectChat[]>;
  listForProject(ownerScope: OwnerScope, projectId: string, limit: number): Promise<ProjectChat[]>;
  /** Agent status from each chat's latest run, one query for all ids. */
  statuses(ownerScope: OwnerScope, chatIds: readonly string[]): Promise<Record<string, TaskAgentStatus>>;
}

export interface ProjectTerminalTab {
  workspaceId: string;
  tabId: string;
  name: string;
}

export interface TerminalPort {
  /** The project's terminal workspace. */
  ensureWorkspace(projectId: string): Promise<{ workspaceId: string }>;
  /**
   * Create a tab, or return the existing one with the same `tabId`. The tab's
   * environment gets `MATRIX_TASK_ID` and `MATRIX_PROJECT_ID`.
   */
  createTab(input: {
    workspaceId: string;
    tabId: string;
    name: string;
    cwd: string;
    env: { MATRIX_TASK_ID: string; MATRIX_PROJECT_ID: string };
    harness?: string;
  }): Promise<{ tabId: string }>;
  listForProject(projectId: string): Promise<ProjectTerminalTab[]>;
  /** Refs (`term.<workspaceId>.<tabId>`) of every tab the project's workspaces still hold, in any status. */
  existingRefs(projectId: string): Promise<string[]>;
  /** Agent status of every live tab, keyed by `term.<workspaceId>.<tabId>`. */
  statuses(): Promise<Record<string, TaskAgentStatus>>;
}

export type PullRequestLookup = { status: "ok"; pullRequest: TaskPullRequest | null } | { status: "unavailable" };

export interface PullRequestPort {
  find(input: { cwd: string; branch: string }): Promise<PullRequestLookup>;
  /** Push the branch and open a pull request for it; returns the new (or already open) pull request. */
  open(input: { cwd: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }): Promise<PullRequestLookup>;
}

export interface TaskSessionPorts {
  worktrees: WorktreePort;
  projectRoot: ProjectRootPort;
  git: GitPort;
  chats: ChatPort;
  terminals: TerminalPort;
  pullRequests: PullRequestPort;
}

/** A port could not do its work right now; the route answers `task_session_unavailable`. */
export class TaskPortUnavailableError extends Error {
  constructor(readonly port: keyof TaskSessionPorts, readonly reason: string) {
    super(`${port}: ${reason}`);
    this.name = "TaskPortUnavailableError";
  }
}
