import {
  ProjectBoardRequestError, TaskAgentWorkingError, TaskConflictError,
  type CreateTaskInput, type ListTasksOptions, type MoveTaskInput, type ProjectBoardClient, type ProjectBoardEvent,
  type StartSessionInput, type UpdateTaskInput,
} from "./client.js";
import {
  FIXTURE_MEMBERS, FIXTURE_OWNER, FIXTURE_PROJECT_ID, FIXTURE_TASK_KEY, buildFixtureSeed, taskBranchName,
} from "./fixture-data.js";
import {
  TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, rankBetween,
  type ActorRef, type AttachableSession, type BoardSettings, type TaskGitSummary, type ProjectTask, type TaskActivity, type TaskActivityKind, type TaskComment, type TaskSession,
} from "./types.js";

export interface FixtureProjectBoardClient extends ProjectBoardClient {
  readonly projectId: string;
  /** While on, every mutation fails with a generic error after the usual latency. */
  setSimulateFailure(on: boolean): void;
  readonly simulatingFailure: boolean;
}

export interface FixtureProjectBoardOptions {
  /** Simulated round trip; defaults to 150ms. */
  latencyMs?: number;
  /** Start with no tasks, to show the empty state. */
  empty?: boolean;
  now?: () => number;
}

// The fixture is bounded like any in-memory store.
const MAX_TASKS = 500;
const MAX_COMMENTS = 2000;
const MAX_ACTIVITY = 5000;
const MAX_LISTENERS = 64;
const MAX_REQUEST_IDS = 200;
const MAX_SESSIONS_PER_TASK = 16;

const clone = <T>(value: T): T => structuredClone(value);

/** Project chats and tabs that exist outside any task, offered by "Attach existing". */
const FIXTURE_ATTACHABLE: readonly AttachableSession[] = [
  { ref: "chat_fixture_loose_1", kind: "chat", title: "Explore Linear webhooks" },
  { ref: "chat_fixture_loose_2", kind: "chat", title: "Why is CI slow?" },
  { ref: "term.tws_fixture.tt_loose_1", kind: "terminal", title: "main · dev server" },
];

/** In-memory `ProjectBoardClient` for tests. Nothing leaves the page; no shipped surface uses it. */
export function createFixtureProjectBoardClient(options: FixtureProjectBoardOptions = {}): FixtureProjectBoardClient {
  const latencyMs = options.latencyMs ?? 150;
  const now = options.now ?? Date.now;
  const seed = options.empty ? { tasks: [], comments: [], activity: [] } : buildFixtureSeed(now());
  let tasks: ProjectTask[] = seed.tasks;
  let comments: TaskComment[] = seed.comments;
  let activity: TaskActivity[] = seed.activity;
  let seq = activity.length;
  let idCounter = 0;
  let simulatingFailure = false;
  const listeners: Array<(event: ProjectBoardEvent) => void> = [];
  const requestIds: Array<{ requestId: string; taskId: string }> = [];
  const actor: ActorRef = FIXTURE_OWNER;
  const attachable = options.empty ? [] : FIXTURE_ATTACHABLE;
  let settings: BoardSettings = {
    projectId: FIXTURE_PROJECT_ID, taskKey: FIXTURE_TASK_KEY, linearConnected: true,
    automation: { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true },
  };

  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  const stamp = () => new Date(now()).toISOString();
  const nextId = (prefix: string) => `${prefix}_local_${now().toString(36)}_${(idCounter += 1)}`;

  const find = (taskId: string): ProjectTask => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new ProjectBoardRequestError("That task no longer exists.");
    return task;
  };

  async function mutation<T>(work: () => T): Promise<T> {
    await wait();
    if (simulatingFailure) throw new ProjectBoardRequestError();
    return clone(work());
  }

  function emit(event: ProjectBoardEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.warn("[project-board] fixture listener failed", error instanceof Error ? error.name : typeof error);
      }
    }
  }

  function log(taskId: string, kind: TaskActivityKind, summary: string, by: ActorRef = actor): void {
    activity.push({ seq: (seq += 1), taskId, actor: by, kind, summary, at: stamp() });
    if (activity.length > MAX_ACTIVITY) activity = activity.slice(-MAX_ACTIVITY);
  }

  function replace(next: ProjectTask): ProjectTask {
    tasks = tasks.map((task) => (task.id === next.id ? next : task));
    return next;
  }

  function columnRanks(status: ProjectTask["status"], excludeId?: string): string[] {
    return tasks.filter((task) => task.status === status && task.id !== excludeId && task.archivedAt === null)
      .map((task) => task.rank).sort();
  }

  function rankFor(status: ProjectTask["status"], taskId: string | undefined, afterTaskId?: string, beforeTaskId?: string): string {
    const after = afterTaskId ? find(afterTaskId).rank : null;
    const before = beforeTaskId ? find(beforeTaskId).rank : null;
    if (after !== null || before !== null) return rankBetween(after, before);
    return rankBetween(null, columnRanks(status, taskId)[0] ?? null);
  }

  function setStatus(task: ProjectTask, status: ProjectTask["status"], rank: string, by: ActorRef = actor): ProjectTask {
    const next = replace({ ...task, status, rank, updatedAt: stamp(), revision: task.revision + 1 });
    if (task.status !== status) log(task.id, "moved", `${TASK_STATUS_LABEL[task.status]} → ${TASK_STATUS_LABEL[status]}`, by);
    emit({ type: "task.moved", taskId: task.id, revision: next.revision });
    return next;
  }

  const client: FixtureProjectBoardClient = {
    projectId: FIXTURE_PROJECT_ID,

    get simulatingFailure() { return simulatingFailure; },
    setSimulateFailure(on) { simulatingFailure = on; },

    async listTasks(query: ListTasksOptions = {}) {
      await wait();
      return clone(tasks.filter((task) => query.includeArchived || task.archivedAt === null));
    },

    async getTask(taskId) {
      await wait();
      return clone(find(taskId));
    },

    async findTaskByChat(chatId) {
      await wait();
      const task = tasks.find((candidate) => candidate.chatId === chatId);
      return task ? clone(task) : null;
    },

    createTask(input: CreateTaskInput) {
      return mutation(() => {
        const existing = requestIds.find((entry) => entry.requestId === input.clientRequestId);
        if (existing) return find(existing.taskId);
        if (tasks.length >= MAX_TASKS) throw new ProjectBoardRequestError("This board is full.");
        const title = input.title.trim().slice(0, 300);
        if (!title) throw new ProjectBoardRequestError("A task needs a title.");
        const status = input.status ?? "backlog";
        const number = tasks.reduce((highest, task) => Math.max(highest, task.number), 0) + 1;
        const created = stamp();
        const task: ProjectTask = {
          id: nextId("task"), projectId: FIXTURE_PROJECT_ID, number, key: `${settings.taskKey}-${number}`, title, description: input.description ?? "", status,
          priority: input.priority ?? "none", rank: input.afterTaskId ? rankAfter(status, input.afterTaskId) : rankFor(status, undefined),
          assignee: input.assignee ?? null, labels: [...(input.labels ?? [])], parentTaskId: input.parentTaskId ?? null, blockedBy: [], dueAt: input.dueAt ?? null,
          worktreeId: null, branch: null, pullRequest: null, externalLink: null, chatId: nextId("chat"), chatStatus: "idle", sessions: [], commentCount: 0, createdBy: actor,
          createdAt: created, updatedAt: created, archivedAt: null, revision: 1,
        };
        tasks = [...tasks, task];
        requestIds.push({ requestId: input.clientRequestId, taskId: task.id });
        if (requestIds.length > MAX_REQUEST_IDS) requestIds.shift();
        log(task.id, "created", "Created the task");
        emit({ type: "task.created", taskId: task.id, revision: task.revision });
        return task;
      });
    },

    updateTask(taskId, baseRevision, input: UpdateTaskInput) {
      return mutation(() => {
        const task = find(taskId);
        if (task.revision !== baseRevision) throw new TaskConflictError(clone(task));
        const next: ProjectTask = {
          ...task, ...input, title: input.title === undefined ? task.title : input.title.trim().slice(0, 300) || task.title,
          updatedAt: stamp(), revision: task.revision + 1,
        };
        if (input.title !== undefined && next.title !== task.title) log(taskId, "renamed", `Renamed to “${next.title}”`);
        if (input.priority !== undefined && input.priority !== task.priority) log(taskId, "priority_changed", `Priority ${TASK_PRIORITY_LABEL[input.priority]}`);
        if (input.assignee !== undefined && input.assignee !== task.assignee) {
          const member = FIXTURE_MEMBERS.find((candidate) => candidate.actor === input.assignee);
          log(taskId, "assigned", input.assignee ? `Assigned to ${member?.name ?? "an agent"}` : "Unassigned");
        }
        if (input.labels !== undefined) log(taskId, "labels_changed", input.labels.length ? `Labels: ${input.labels.join(", ")}` : "Removed all labels");
        replace(next);
        emit({ type: "task.updated", taskId, revision: next.revision });
        return next;
      });
    },

    moveTask(taskId, input: MoveTaskInput) {
      return mutation(() => {
        const task = find(taskId);
        const closing = (input.status === "done" || input.status === "canceled") && task.status !== input.status;
        if (closing && !input.force && task.sessions.some((session) => session.agentStatus === "working")) throw new TaskAgentWorkingError();
        return setStatus(task, input.status, rankFor(input.status, taskId, input.afterTaskId, input.beforeTaskId));
      });
    },

    archiveTask(taskId, archived) {
      return mutation(() => {
        const task = find(taskId);
        const next = replace({ ...task, archivedAt: archived ? stamp() : null, updatedAt: stamp(), revision: task.revision + 1 });
        log(taskId, archived ? "archived" : "unarchived", archived ? "Archived the task" : "Restored the task");
        emit({ type: "task.updated", taskId, revision: next.revision });
        return next;
      });
    },

    deleteTask(taskId) {
      return mutation(() => {
        const task = find(taskId);
        tasks = tasks.filter((candidate) => candidate.id !== taskId);
        emit({ type: "task.deleted", taskId, revision: task.revision + 1 });
      });
    },

    async listComments(taskId) {
      await wait();
      return clone(comments.filter((comment) => comment.taskId === taskId));
    },

    addComment(taskId, body) {
      return mutation(() => {
        const task = find(taskId);
        const text = body.trim().slice(0, 10_000);
        if (!text) throw new ProjectBoardRequestError("A comment can't be empty.");
        if (comments.length >= MAX_COMMENTS) comments = comments.slice(1);
        const comment: TaskComment = { id: nextId("tcm"), taskId, author: actor, body: text, createdAt: stamp(), editedAt: null };
        comments = [...comments, comment];
        const next = replace({ ...task, commentCount: task.commentCount + 1, updatedAt: stamp(), revision: task.revision + 1 });
        emit({ type: "task.comment_added", taskId, revision: next.revision });
        return comment;
      });
    },

    async listActivity(taskId) {
      await wait();
      return clone(activity.filter((entry) => entry.taskId === taskId));
    },

    startWork(taskId, input: StartSessionInput) {
      return mutation(() => {
        let task = find(taskId);
        let session: TaskSession | null = null;
        if (input.kind === "terminal") {
          if (task.sessions.length >= MAX_SESSIONS_PER_TASK) throw new ProjectBoardRequestError("A task can hold up to 16 terminals.");
          const index = task.sessions.length;
          session = {
            ref: `term.tws_fixture.${nextId("tt")}`, kind: "terminal", title: `Terminal ${index + 1}`,
            role: index === 0 ? "main" : "extra", agentStatus: "idle", harness: input.harness ?? "Shell",
          };
        }
        task = replace({
          ...task, sessions: session ? [...task.sessions, session] : task.sessions,
          branch: task.branch ?? taskBranchName(FIXTURE_TASK_KEY, task.number, task.title), updatedAt: stamp(), revision: task.revision + 1,
        });
        if (session) log(taskId, "session_started", `Started ${session.title} (${session.harness})`);
        if (task.status === "backlog" || task.status === "todo") {
          setStatus(task, "in_progress", rankFor("in_progress", taskId), "system:automation");
        } else {
          emit({ type: "task.updated", taskId, revision: task.revision });
        }
        return { task: clone(find(taskId)), session, ...(session ? {} : { firstMessage: `${task.key}: ${task.title}` }) };
      });
    },

    async listAttachableSessions() {
      await wait();
      const bound = tasks.flatMap((task) => task.sessions.map((session) => session.ref));
      return attachable.filter((session) => !bound.includes(session.ref)).map(clone);
    },

    attachSession(taskId, input: AttachableSession) {
      return mutation(() => {
        const task = find(taskId);
        if (task.sessions.some((session) => session.ref === input.ref)) return task.sessions.find((session) => session.ref === input.ref)!;
        if (task.sessions.length >= MAX_SESSIONS_PER_TASK) throw new ProjectBoardRequestError("A task can hold up to 16 chats and terminals.");
        const session: TaskSession = { ...input, role: task.sessions.length === 0 ? "main" : "extra", agentStatus: "idle", harness: input.kind === "chat" ? "Claude Code" : "Shell" };
        const next = replace({ ...task, sessions: [...task.sessions, session], updatedAt: stamp(), revision: task.revision + 1 });
        log(taskId, "session_attached", `Attached ${session.title}`);
        emit({ type: "task.updated", taskId, revision: next.revision });
        return session;
      });
    },

    async getGitSummary(taskId): Promise<TaskGitSummary> {
      await wait();
      const task = find(taskId);
      return {
        branch: task.branch, dirty: task.status === "in_progress", ahead: task.branch ? 3 : 0, behind: task.branch ? 1 : 0,
        changedFiles: task.branch ? 7 : 0, pullRequest: task.pullRequest, prStatus: "ok",
      };
    },

    createPullRequest(taskId) {
      return mutation(() => {
        const task = find(taskId);
        if (!task.branch) throw new ProjectBoardRequestError("Start work on this task before opening a pull request.");
        if (task.pullRequest) return task;
        const number = 3500 + task.number;
        let next = replace({
          ...task, pullRequest: { number, url: `https://github.com/example/project/pull/${number}`, state: "open", checks: "pending", review: "review_required" },
          updatedAt: stamp(), revision: task.revision + 1,
        });
        log(taskId, "pr_opened", `Opened pull request #${number}`, "system:automation");
        if (next.status === "in_progress") next = setStatus(next, "in_review", rankFor("in_review", taskId), "system:automation");
        else emit({ type: "task.updated", taskId, revision: next.revision });
        return next;
      });
    },

    async listMembers() {
      await wait();
      return clone(FIXTURE_MEMBERS);
    },

    async getSettings(): Promise<BoardSettings> {
      await wait();
      return clone(settings);
    },

    updateSettings(input) {
      return mutation(() => {
        settings = { ...settings, taskKey: input.taskKey ?? settings.taskKey, automation: { ...settings.automation, ...input.automation } };
        return settings;
      });
    },

    detachSession(taskId, ref) {
      return mutation(() => {
        const task = find(taskId);
        const session = task.sessions.find((candidate) => candidate.ref === ref);
        if (!session) return task;
        const sessions = task.sessions.filter((candidate) => candidate.ref !== ref)
          .map((candidate, index) => ({ ...candidate, role: index === 0 ? "main" as const : "extra" as const }));
        const next = replace({ ...task, sessions, updatedAt: stamp(), revision: task.revision + 1 });
        log(taskId, "session_detached", `Detached ${session.title}`);
        emit({ type: "task.updated", taskId, revision: next.revision });
        return next;
      });
    },

    subscribe(listener) {
      if (listeners.length >= MAX_LISTENERS) listeners.shift();
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };

  function rankAfter(status: ProjectTask["status"], afterTaskId: string): string {
    const after = find(afterTaskId).rank;
    const next = columnRanks(status).find((rank) => rank > after) ?? null;
    return rankBetween(after, next);
  }

  return client;
}
