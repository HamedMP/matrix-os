import { vi } from "vitest";
import type { ProjectBoardClient, ProjectBoardEvent } from "../../packages/ui/src/project-board/client";
import type { BoardSettings, ProjectTask, TaskGitSummary } from "../../packages/ui/src/project-board/types";

export function boardTask(id: string, overrides: Partial<ProjectTask> = {}): ProjectTask {
  const number = Number(id.replace(/\D/g, "")) || 1;
  return {
    id, projectId: "proj_1", number, key: `MOS-${number}`, title: `Task ${id}`, description: "",
    status: "todo", priority: "none", rank: "a", assignee: null, labels: [], parentTaskId: null, blockedBy: [],
    dueAt: null, worktreeId: null, branch: null, pullRequest: null, externalLink: null, chatId: `chat_${id}`, chatStatus: "idle", sessions: [], commentCount: 0,
    createdBy: "user:owner", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null, revision: 1, ...overrides,
  };
}

const SETTINGS: BoardSettings = {
  projectId: "proj_1", taskKey: "MOS", linearConnected: false,
  automation: { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true },
};

const GIT: TaskGitSummary = { branch: null, dirty: false, ahead: 0, behind: 0, changedFiles: 0, pullRequest: null, prStatus: "ok" };

/** A board client whose task list is `tasks`; every call is a spy that tests can override. */
export function fakeBoardClient(tasks: () => readonly ProjectTask[]) {
  const listeners: Array<(event: ProjectBoardEvent) => void> = [];
  const client = {
    listTasks: vi.fn(async () => tasks()),
    getTask: vi.fn(async (id: string) => tasks().find((task) => task.id === id)!),
    findTaskByChat: vi.fn(async (chatId: string) => tasks().find((task) => task.chatId === chatId) ?? null),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    archiveTask: vi.fn(),
    deleteTask: vi.fn(),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(),
    listActivity: vi.fn(async () => []),
    startWork: vi.fn(),
    listAttachableSessions: vi.fn(async () => []),
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    getGitSummary: vi.fn(async () => GIT),
    createPullRequest: vi.fn(),
    listMembers: vi.fn(async () => []),
    getSettings: vi.fn(async () => SETTINGS),
    updateSettings: vi.fn(),
    subscribe: vi.fn((listener: (event: ProjectBoardEvent) => void) => {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    }),
  } satisfies Record<keyof ProjectBoardClient, unknown>;
  return {
    client: client as unknown as ProjectBoardClient & typeof client,
    emit(event: ProjectBoardEvent) { for (const listener of [...listeners]) listener(event); },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
