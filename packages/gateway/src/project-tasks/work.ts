/**
 * Start work, attach and detach terminals, git and pull request state (spec
 * 2699 sections 3 and 4). Start work crosses subsystems, so it is not one
 * transaction: every step is idempotent and the task records what succeeded,
 * so a retry with the same `clientRequestId` resumes instead of duplicating.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  TASK_LIMITS, TaskBranchSchema,
  type AttachableSession, type ProjectTask, type StartTaskBodySchema, type TaskGitSummary, type TaskSession,
} from "@matrix-os/contracts/project-tasks";
import type { z } from "zod/v4";
import { ProjectFenceError } from "../collaboration/project-fence.js";
import type { RequestPrincipal } from "../request-principal.js";
import { ProjectTaskError } from "./errors.js";
import { PullRequestCache } from "./pr-cache.js";
import { DEFAULT_AUTOMATION, type TaskRow } from "./repository.js";
import type { ProjectTaskService, TaskCaller, BoardContext } from "./service.js";
import { toTaskSession } from "./service.js";
import { TaskPortUnavailableError, type PullRequestLookup, type TaskSessionPorts, type TaskWorktree } from "./session-ports.js";
import type { ProjectTaskSessionRepository, SessionLinkInput } from "./sessions.js";

type StartTaskBody = z.output<typeof StartTaskBodySchema>;
/** Runs one board write behind the shared-project fence. */
export type WriteAdmission = <T>(run: () => Promise<T>) => Promise<T>;
const BRANCH_MAX = 60;
const ATTACHABLE_MAX = 200;
const SUPPORTED_HARNESSES = new Set(["claude", "codex", "opencode", "pi"]);

/** `task/<key>-<title slug>`, lowercase, at most 60 characters, built only by the server. */
export function taskBranchName(key: string, title: string): string {
  const slug = `${key}-${title}`.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const branch = `task/${slug}`.slice(0, BRANCH_MAX).replace(/[-./]+$/, "");
  return TaskBranchSchema.parse(branch);
}

/** The first message: key, title and description, then the caller's own text. */
export function firstMessageText(task: Pick<ProjectTask, "key" | "title" | "description">, message?: string): string {
  return [`${task.key}: ${task.title}`, task.description.trim(), message?.trim() ?? ""].filter(Boolean).join("\n\n");
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function parseTerminalRef(ref: string): { workspaceId: string; tabId: string } | null {
  const [prefix, workspaceId, tabId] = ref.split(".");
  return prefix === "term" && workspaceId && tabId ? { workspaceId, tabId } : null;
}

export interface ProjectTaskWorkOptions {
  tasks: ProjectTaskService;
  sessions: ProjectTaskSessionRepository;
  ports: TaskSessionPorts;
  cache?: PullRequestCache;
}

export interface StartResult {
  task: ProjectTask;
  /** The attached terminal; null for a chat start (the chat is `task.chatId`). */
  session: TaskSession | null;
  firstMessage?: string;
}

export class ProjectTaskWork {
  private readonly cache: PullRequestCache;

  constructor(private readonly options: ProjectTaskWorkOptions) {
    this.cache = options.cache ?? new PullRequestCache();
  }

  /**
   * Start work. `kind: "chat"` prepares the task's own chat: the worktree and
   * branch, the chat's default root bound to that worktree, and the first
   * message (sent when a model is selected, otherwise returned for the
   * composer). `kind: "terminal"` attaches a new terminal tab to the task.
   */
  async start(caller: TaskCaller, slug: string, taskId: string, body: StartTaskBody, principal?: RequestPrincipal): Promise<StartResult> {
    const { tasks, sessions } = this.options;
    const context = await tasks.open(caller, slug);
    let row = await tasks.requireRow(context, taskId);
    if (body.kind === "terminal" && body.harness && !SUPPORTED_HARNESSES.has(body.harness)) throw new ProjectTaskError("invalid_request");
    if (body.kind === "chat" && !row.chat_id) throw new ProjectTaskError("task_session_unavailable");
    const requestId = body.clientRequestId ?? `req_${randomUUID()}`;
    const seed = digest(context.scope.ownerId, taskId, requestId);
    const view = await tasks.task(context, row);

    // A retried terminal start whose link already landed skips straight to the remaining steps.
    let link = body.kind === "terminal" ? await sessions.findByStartRequest(context.scope, taskId, requestId) : undefined;
    // Closed tabs do not count toward the limit; a full task drops them to make room.
    const prune = view.sessions.filter((session) => session.unavailable).map((session) => session.ref);
    if (body.kind === "terminal" && !link && view.sessions.length - prune.length >= TASK_LIMITS.sessions) throw new ProjectTaskError("task_limit_reached");

    const root = await this.port(() => this.options.ports.projectRoot.resolve(context.project, caller.ownerScope));
    if (!root) throw new ProjectTaskError("task_session_unavailable");
    let worktree: TaskWorktree | null = null;
    if (root.git && body.worktree !== "none") {
      worktree = row.worktree_id ? await this.port(() => this.options.ports.worktrees.get({
        projectSlug: slug, ownerScope: caller.ownerScope, worktreeId: row.worktree_id!,
      })) : null;
      if (!worktree && body.worktree === "existing") throw new ProjectTaskError("invalid_request");
      if (!worktree) {
        const branch = row.branch ?? taskBranchName(view.key, view.title);
        const ensured = await this.port(() => this.options.ports.worktrees.ensure({ projectSlug: slug, ownerScope: caller.ownerScope, branch }));
        row = await sessions.recordWorktree(context.scope, taskId, ensured.id, ensured.branch);
        worktree = row.worktree_id === ensured.id ? ensured : await this.port(() => this.options.ports.worktrees.get({
          projectSlug: slug, ownerScope: caller.ownerScope, worktreeId: row.worktree_id!,
        })) ?? ensured;
      }
    }
    const cwd = worktree?.path ?? root.path;
    const title = `${view.key} ${view.title}`.slice(0, 160);
    const text = firstMessageText(view, body.message);
    let sent = false;

    if (body.kind === "chat") {
      const chatId = row.chat_id!;
      if (worktree) {
        const bound = worktree;
        await this.port(() => this.options.ports.chats.bindWorktree(caller.ownerScope, chatId, { projectId: context.project.id, worktreeId: bound.id }));
      }
      if (body.selection && principal) {
        try {
          const revision = await this.port(() => this.options.ports.chats.revision(caller.ownerScope, chatId));
          if (revision === null) throw new ProjectTaskError("task_session_unavailable");
          await this.options.ports.chats.admitFirstTurn({
            principal, ownerScope: caller.ownerScope, chatId, baseRevision: revision,
            clientRequestId: `req_turn_${seed.slice(0, 40)}`, text, selection: body.selection,
            executionRoot: worktree
              ? { kind: "worktree", projectId: context.project.id, worktreeId: worktree.id }
              : { kind: "project", projectId: context.project.id },
          });
          sent = true;
        } catch (error: unknown) {
          // The chat exists; the composer gets the text instead.
          console.warn("[project-tasks] first turn not admitted", error instanceof Error ? error.name : typeof error);
        }
      }
    } else if (!link) {
      const { workspaceId } = await this.port(() => this.options.ports.terminals.ensureWorkspace(context.project.id));
      const { tabId } = await this.port(() => this.options.ports.terminals.createTab({
        workspaceId, tabId: `tt_${seed.slice(0, 32)}`, name: title, cwd,
        env: { MATRIX_TASK_ID: taskId, MATRIX_PROJECT_ID: context.project.id },
        ...(body.harness ? { harness: body.harness } : {}),
      }));
      const input: SessionLinkInput = {
        ref: `term.${workspaceId}.${tabId}`, kind: "terminal", title, startRequestId: requestId, prune,
        ...(body.harness ? { harness: body.harness } : {}),
      };
      link = (await sessions.link(context.scope, taskId, input, caller.actor, "session_started")).row;
    }

    if (context.board.automation.startMovesToInProgress ?? DEFAULT_AUTOMATION.startMovesToInProgress) {
      await sessions.advance(context.scope, taskId, ["backlog", "todo"], "in_progress");
    }
    const task = await tasks.task(context, await tasks.requireRow(context, taskId));
    await tasks.signal("task.updated", context, task);
    const session: TaskSession | null = link
      ? task.sessions.find((candidate) => candidate.ref === link!.session_ref) ?? toTaskSession(link, "idle")
      : null;
    return { task, session, ...(sent ? {} : { firstMessage: text }) };
  }

  /** Attach a terminal tab of the project; a task's chat is the task itself, so chats are never attached. */
  async attach(caller: TaskCaller, slug: string, taskId: string, ref: string): Promise<ProjectTask> {
    const context = await this.options.tasks.open(caller, slug);
    const view = await this.options.tasks.task(context, await this.options.tasks.requireRow(context, taskId));
    const prune = view.sessions.filter((session) => session.unavailable).map((session) => session.ref);
    const parsed = parseTerminalRef(ref);
    if (!parsed) throw new ProjectTaskError("invalid_request");
    const tabs = await this.port(() => this.options.ports.terminals.listForProject(context.project.id));
    const title = tabs.find((tab) => tab.workspaceId === parsed.workspaceId && tab.tabId === parsed.tabId)?.name;
    if (!title) throw new ProjectTaskError("task_session_not_found");
    await this.options.sessions.link(context.scope, taskId, { ref, kind: "terminal", title: title.slice(0, 200) || ref, prune }, caller.actor, "session_attached");
    return this.changed(context, taskId);
  }

  async detach(caller: TaskCaller, slug: string, taskId: string, ref: string): Promise<ProjectTask> {
    const context = await this.options.tasks.open(caller, slug);
    await this.options.sessions.unlink(context.scope, taskId, ref, caller.actor);
    return this.changed(context, taskId);
  }

  /** The project's terminal tabs that no task owns yet, at most 200. */
  async attachable(caller: TaskCaller, slug: string): Promise<AttachableSession[]> {
    const context = await this.options.tasks.open(caller, slug);
    const tabs = await this.port(() => this.options.ports.terminals.listForProject(context.project.id));
    const candidates: AttachableSession[] = tabs.slice(0, ATTACHABLE_MAX * 2)
      .map((tab) => ({ ref: `term.${tab.workspaceId}.${tab.tabId}`, kind: "terminal" as const, title: tab.name.slice(0, 200) || "Terminal" }));
    const bound = await this.options.sessions.boundRefs(context.scope, candidates.map((candidate) => candidate.ref));
    return candidates.filter((candidate) => !bound.has(candidate.ref)).slice(0, ATTACHABLE_MAX);
  }

  /**
   * Branch, working-tree state and the pull request summary, refreshed through
   * the bounded cache. Storing the summary (and its automation) is a write, so
   * it runs through `admitWrite`; when the project fence refuses it, the read is
   * still served and nothing is stored.
   */
  async git(caller: TaskCaller, slug: string, taskId: string, admitWrite: WriteAdmission = (run) => run()): Promise<{ git: TaskGitSummary; task: ProjectTask }> {
    const context = await this.options.tasks.open(caller, slug);
    const row = await this.options.tasks.requireRow(context, taskId);
    const cwd = await this.checkout(context, caller, row);
    const local = cwd ? await this.port(() => this.options.ports.git.summary({ cwd, defaultBranch: this.defaultBranch(context) })) : null;
    let lookup: PullRequestLookup = { status: "ok", pullRequest: null };
    if (cwd && row.branch) {
      const key = this.cacheKey(context, taskId, row.branch);
      const cached = this.cache.get(key);
      if (cached) {
        lookup = cached;
      } else {
        // Only a fresh lookup is cached, so frequent reads cannot keep extending the 60 s expiry.
        lookup = await this.options.ports.pullRequests.find({ cwd, branch: row.branch });
        this.cache.set(key, lookup);
      }
    }
    let task: ProjectTask;
    try {
      task = await this.storeLookup(context, row, lookup, admitWrite);
    } catch (error: unknown) {
      if (!(error instanceof ProjectFenceError)) throw error;
      console.warn("[project-tasks] pull request summary not stored", error.code);
      task = await this.options.tasks.task(context, row);
    }
    return { git: this.summary(row.branch, local, lookup, task), task };
  }

  async openPullRequest(caller: TaskCaller, slug: string, taskId: string, draft: boolean): Promise<{ git: TaskGitSummary; task: ProjectTask }> {
    const context = await this.options.tasks.open(caller, slug);
    const row = await this.options.tasks.requireRow(context, taskId);
    const cwd = row.worktree_id ? await this.checkout(context, caller, row) : null;
    if (!cwd || !row.branch) throw new ProjectTaskError("invalid_request");
    const view = await this.options.tasks.task(context, row);
    const lookup = await this.options.ports.pullRequests.open({
      cwd, branch: row.branch, baseBranch: this.defaultBranch(context), draft,
      title: `${view.key}: ${view.title}`.slice(0, 256),
      body: [view.description.trim().slice(0, 20_000), `Board task ${view.key}.`].filter(Boolean).join("\n\n"),
    });
    const key = this.cacheKey(context, taskId, row.branch);
    if (lookup.status === "ok") this.cache.set(key, lookup); else this.cache.delete(key);
    const local = await this.port(() => this.options.ports.git.summary({ cwd, defaultBranch: this.defaultBranch(context) }));
    const task = await this.storeLookup(context, row, lookup);
    return { git: this.summary(row.branch, local, lookup, task), task };
  }

  // -------------------------------------------------------------------------

  private summary(branch: string | null, local: { dirty: boolean; ahead: number; behind: number; changedFiles: number } | null, lookup: PullRequestLookup, task: ProjectTask): TaskGitSummary {
    return {
      branch,
      dirty: local?.dirty ?? false,
      ahead: local?.ahead ?? 0,
      behind: local?.behind ?? 0,
      changedFiles: local?.changedFiles ?? 0,
      pullRequest: lookup.status === "ok" ? lookup.pullRequest : task.pullRequest,
      prStatus: lookup.status,
    };
  }

  /** Store a fresh lookup on the task (with forward-only automation); an unavailable lookup keeps the stored summary. */
  private async storeLookup(context: BoardContext, row: TaskRow, lookup: PullRequestLookup, admitWrite: WriteAdmission = (run) => run()): Promise<ProjectTask> {
    if (lookup.status !== "ok" || (lookup.pullRequest === null && row.pr_number === null)) return this.options.tasks.task(context, row);
    const pullRequest = lookup.pullRequest;
    const { row: stored, changed } = await admitWrite(() => this.options.sessions.storePullRequest(
      context.scope, row.id, pullRequest, { ...DEFAULT_AUTOMATION, ...context.board.automation },
    ));
    const task = await this.options.tasks.task(context, stored);
    if (changed) await this.options.tasks.signal("task.updated", context, task);
    return task;
  }

  private async checkout(context: BoardContext, caller: TaskCaller, row: TaskRow): Promise<string | null> {
    if (row.worktree_id) {
      const worktree = await this.port(() => this.options.ports.worktrees.get({
        projectSlug: context.slug, ownerScope: caller.ownerScope, worktreeId: row.worktree_id!,
      }));
      if (worktree) return worktree.path;
    }
    const root = await this.port(() => this.options.ports.projectRoot.resolve(context.project, caller.ownerScope));
    return root?.git ? root.path : null;
  }

  private defaultBranch(context: BoardContext): string {
    const configured = context.project.defaultBranch ?? "main";
    return TaskBranchSchema.safeParse(configured).success ? configured : "main";
  }

  private cacheKey(context: BoardContext, taskId: string, branch: string): string {
    return `${context.scope.ownerId}\u0000${context.scope.projectId}\u0000${taskId}\u0000${branch}`;
  }

  private async changed(context: BoardContext, taskId: string): Promise<ProjectTask> {
    const task = await this.options.tasks.task(context, await this.options.tasks.requireRow(context, taskId));
    await this.options.tasks.signal("task.updated", context, task);
    return task;
  }

  /** Port failures become the generic `task_session_unavailable`; board errors pass through. */
  private async port<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error: unknown) {
      if (error instanceof ProjectTaskError) throw error;
      console.warn("[project-tasks] session port failed", error instanceof TaskPortUnavailableError ? error.port : error instanceof Error ? error.name : typeof error);
      throw new ProjectTaskError("task_session_unavailable");
    }
  }
}
