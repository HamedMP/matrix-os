jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

import {
  AGENT_WORKSPACE_STATE_STORAGE_KEY,
  createEmptyAgentWorkspaceState,
  loadAgentWorkspaceState,
  parseAgentWorkspaceState,
  reconcileAgentWorkspaceState,
  saveAgentWorkspaceState,
  selectAgentWorkspaceThread,
} from "../lib/agent-workspace-state";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";

const summary = {
  runtime: { id: "rt_primary", label: "Primary", status: "available" },
  capabilities: [],
  providers: [],
  projects: {
    items: [
      {
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 1,
        threadCount: 3,
        attentionCount: 1,
      },
      {
        id: "website",
        label: "Website",
        status: "available",
        taskCount: 0,
        threadCount: 0,
        attentionCount: 0,
      },
    ],
    hasMore: false,
    limit: 50,
  },
  activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 },
  terminalSessions: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: {
    maxPromptBytes: 16_384,
    maxAttachmentCount: 8,
    maxTerminalInputBytes: 8_192,
    maxListItems: 20,
  },
  serverTime: "2026-07-10T14:00:00.000Z",
} satisfies RuntimeSummary;

const threadBase = {
  providerId: "codex",
  title: "Coding conversation",
  status: "running" as const,
  attention: "none" as const,
  projectId: "matrix-os",
  createdAt: "2026-07-10T13:00:00.000Z",
  updatedAt: "2026-07-10T13:30:00.000Z",
};

const workspace = {
  project: summary.projects.items[0],
  tasks: {
    items: [
      {
        id: "task_auth",
        projectId: "matrix-os",
        title: "Repair authentication",
        status: "running",
        priority: "high",
        order: 0,
        threadCount: 2,
        activeThreadCount: 1,
        attentionCount: 1,
      },
    ],
    hasMore: false,
    limit: 100,
  },
  projectThreads: {
    items: [{ ...threadBase, id: "thread_audit", title: "Project audit" }],
    hasMore: false,
    limit: 100,
  },
  taskThreads: {
    items: [
      { ...threadBase, id: "thread_plan", taskId: "task_auth", title: "Plan repair" },
      { ...threadBase, id: "thread_fix", taskId: "task_auth", title: "Implement repair" },
    ],
    hasMore: false,
    limit: 100,
  },
  updatedAt: "2026-07-10T13:30:00.000Z",
} satisfies ProjectAgentWorkspace;

describe("agent workspace state", () => {
  it("parses only bounded safe project workspace references", () => {
    expect(parseAgentWorkspaceState({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "kanban",
      updatedAt: "2026-07-10T14:00:00.000Z",
      transcript: "private transcript",
      events: [{ text: "private event" }],
      terminalOutput: "private output",
      fileContents: "private file",
      diff: "private diff",
      approval: { command: "private command" },
      providerCredentials: "secret",
      bearerToken: "secret",
      resumeIdentity: "secret",
    })).toEqual({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "kanban",
      updatedAt: "2026-07-10T14:00:00.000Z",
    });
  });

  it("drops malformed references independently and defaults to Conversation", () => {
    expect(parseAgentWorkspaceState({
      selectedRuntimeId: "../runtime",
      selectedProjectId: "/tmp/private",
      selectedTaskId: "bad task",
      selectedThreadId: "../bad",
      viewMode: "transcript",
      updatedAt: "not a date",
    })).toEqual(createEmptyAgentWorkspaceState());
  });

  it("reconciles runtime and project selection before using child references", () => {
    const previousRuntime = parseAgentWorkspaceState({
      selectedRuntimeId: "rt_previous",
      selectedProjectId: "website",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "kanban",
      updatedAt: "2026-07-10T13:00:00.000Z",
    });

    expect(reconcileAgentWorkspaceState(previousRuntime, summary)).toEqual({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: null,
      selectedThreadId: null,
      viewMode: "kanban",
      updatedAt: "2026-07-10T13:00:00.000Z",
    });
  });

  it("preserves either independently selectable task thread and its exact identity", () => {
    const selected = parseAgentWorkspaceState({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "conversation",
      updatedAt: "2026-07-10T13:00:00.000Z",
    });

    expect(reconcileAgentWorkspaceState(selected, summary, workspace)).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
    });
    expect(selectAgentWorkspaceThread(selected, workspace, "thread_plan")).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_plan",
      viewMode: "conversation",
    });
    expect(selectAgentWorkspaceThread(selected, workspace, "thread_audit")).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: null,
      selectedThreadId: "thread_audit",
      viewMode: "conversation",
    });
  });

  it("drops stale task and thread references after workspace hydration", () => {
    const selected = parseAgentWorkspaceState({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_missing",
      selectedThreadId: "thread_missing",
      viewMode: "conversation",
      updatedAt: "2026-07-10T13:00:00.000Z",
    });

    expect(reconcileAgentWorkspaceState(selected, summary, workspace)).toMatchObject({
      selectedProjectId: "matrix-os",
      selectedTaskId: null,
      selectedThreadId: null,
    });
  });

  it("loads malformed storage safely and serializes only the allowlist", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = {
      getItem: jest.fn().mockResolvedValue("{not json"),
      setItem: jest.fn().mockResolvedValue(undefined),
    };

    await expect(loadAgentWorkspaceState(storage)).resolves.toEqual(createEmptyAgentWorkspaceState());

    await saveAgentWorkspaceState({
      selectedRuntimeId: "rt_primary",
      selectedProjectId: "matrix-os",
      selectedTaskId: "task_auth",
      selectedThreadId: "thread_fix",
      viewMode: "kanban",
      updatedAt: "2026-07-10T14:00:00.000Z",
      transcript: "must not persist",
    } as never, storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      AGENT_WORKSPACE_STATE_STORAGE_KEY,
      JSON.stringify({
        selectedRuntimeId: "rt_primary",
        selectedProjectId: "matrix-os",
        selectedTaskId: "task_auth",
        selectedThreadId: "thread_fix",
        viewMode: "kanban",
        updatedAt: "2026-07-10T14:00:00.000Z",
      }),
    );
    expect(storage.setItem.mock.calls[0][1]).not.toMatch(
      /transcript|events|terminalOutput|fileContents|diff|approval|Credentials|bearer|resume/i,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[mobile] agent workspace selection could not be restored",
      { name: "SyntaxError" },
    );
    warnSpy.mockRestore();
  });
});
