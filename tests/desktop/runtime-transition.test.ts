import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDesktopRuntimeChange } from "../../desktop/src/renderer/src/stores/runtime-transition";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useEditorTabs } from "../../desktop/src/renderer/src/features/editor/editor-tabs-store";
import { useGit } from "../../desktop/src/renderer/src/stores/git";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads } from "../../desktop/src/renderer/src/stores/threads";
import { useWorkspace } from "../../desktop/src/renderer/src/stores/workspace";

describe("desktop runtime transition", () => {
  beforeEach(() => {
    useBoard.setState({
      projects: [{ slug: "old-project", name: "Old project" }],
      activeProjectSlug: "old-project",
      cardsByProject: { "old-project": [] },
      firstLoadByProject: { "old-project": false },
      refreshing: false,
      error: null,
    });
    useTabs.setState({
      tabs: [{ id: "old-task", kind: "task", title: "Old task", projectSlug: "old-project", taskId: "task_old", closable: true }],
      activeTabId: "old-task",
    });
    useSessions.setState({ sessions: [{ name: "old", attachName: "old", status: "active", source: "zellij" }], aliasMap: { session_old: "old" } });
    useShellSessions.setState({ sessions: [{ name: "old" }] });
    useGit.setState({ branches: [{ name: "old" }], prs: [], worktrees: [], previews: [{ id: "preview_old" }], previewScope: { projectSlug: "old-project", taskId: "task_old" } });
    useWorkspace.setState({ entries: [{ taskId: "task_old", lastFocusedAt: 1, live: true }] });
    useEditorTabs.setState({ tabsByTask: { task_old: ["README.md"] }, activePathByTask: { task_old: "README.md" }, dirtyPathsByTask: {} });
    useThreads.setState({ threads: [], activeThreadId: "thread_old" });
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_old", selectedReviewId: "review_old" });
    useCodingAgentProjectWorkspace.setState({ selectedProjectId: "proj_old", selectedTaskId: "task_old", selectedThreadId: "thread_old" });
  });

  it("atomically removes identifiers and attachments owned by the previous computer", () => {
    const disposeRuntimeAttachments = vi.fn();

    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments });

    expect(disposeRuntimeAttachments).toHaveBeenCalledOnce();
    expect(useBoard.getState()).toMatchObject({ projects: [], activeProjectSlug: null, cardsByProject: {} });
    expect(useTabs.getState().tabs.some((tab) => tab.id === "old-task")).toBe(false);
    expect(useSessions.getState()).toMatchObject({ sessions: [], aliasMap: {} });
    expect(useShellSessions.getState().sessions).toEqual([]);
    expect(useGit.getState()).toMatchObject({ branches: [], previews: [], previewScope: null });
    expect(useWorkspace.getState().entries).toEqual([]);
    expect(useEditorTabs.getState().tabsByTask).toEqual({});
    expect(useThreads.getState()).toMatchObject({ threads: [], activeThreadId: null });
    expect(useCodingAgentWorkspace.getState()).toMatchObject({ activeThreadId: null, selectedReviewId: null });
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject({
      selectedProjectId: null,
      selectedTaskId: null,
      selectedThreadId: null,
    });
  });

  it("reopens the Home tab so the desktop is never left blank after a switch", () => {
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });

    const { tabs, activeTabId } = useTabs.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "home", closable: false });
    expect(activeTabId).toBe(tabs[0]?.id);
  });

  it("clears the Hermes chat transcript and session owned by the previous computer", () => {
    useHermesChat.setState({
      messages: [{ id: "m1", role: "user", content: "old transcript", requestId: "r1", timestamp: 1 }],
      sessionId: "session-old",
      status: "streaming",
      activeRequestId: "r1",
    });

    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });

    expect(useHermesChat.getState()).toMatchObject({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
    });
  });

  it("discards an in-flight shell create that settles after the computer changes", async () => {
    let resolveCreate!: (value: { name: string }) => void;
    const api = {
      post: vi.fn(() => new Promise<{ name: string }>((resolve) => {
        resolveCreate = resolve;
      })),
      get: vi.fn(async () => ({ sessions: [] })),
    } as never;
    useShellSessions.setState({ sessions: [], creating: false, error: null });

    const pending = useShellSessions.getState().create(api);
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveCreate({ name: "matrix-old-1" });
    const created = await pending;

    expect(created).toBeNull();
    expect(useShellSessions.getState().sessions).toEqual([]);
    expect(useShellSessions.getState().creating).toBe(false);
  });

  it("discards an in-flight workspace session create that settles after the computer changes", async () => {
    let resolveCreate!: (value: unknown) => void;
    const api = {
      post: vi.fn(() => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
      get: vi.fn(async () => ({ sessions: [], nextCursor: null })),
      delete: vi.fn(async () => ({})),
    } as never;
    useSessions.setState({ sessions: [], aliasMap: {}, creating: false });

    const pending = useSessions.getState().create(api, { kind: "shell" });
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveCreate({ session: { id: "session_stale", runtime: { zellijSession: "stale-zellij" } } });
    const created = await pending;

    expect(created).toBeNull();
    expect(useSessions.getState().sessions).toEqual([]);
    expect(useSessions.getState().aliasMap).toEqual({});
  });

  it("discards an in-flight session restart that settles after the computer changes", async () => {
    let resolveRestart: ((value: unknown) => void) | undefined;
    const api = {
      post: vi.fn(() => new Promise((resolve) => {
        resolveRestart = resolve;
      })),
      get: vi.fn(async () => ({ sessions: [], nextCursor: null })),
      delete: vi.fn(async () => ({})),
    } as never;

    const pending = useSessions.getState().restart(api, "old");
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    // Let the restart flow advance past the delete; with the generation guard
    // it bails before ever issuing the create POST.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveRestart?.({ name: "old" });
    const restarted = await pending;

    expect(restarted).toBeNull();
    expect(useSessions.getState().sessions).toEqual([]);
  });

  it("discards an in-flight board project create that settles after the computer changes", async () => {
    let resolveCreate!: (value: unknown) => void;
    const api = {
      post: vi.fn(() => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
      get: vi.fn(async () => ({ projects: [{ slug: "stale", name: "Stale" }] })),
    } as never;
    useBoard.setState({ projects: [], activeProjectSlug: null, error: null });

    const pending = useBoard.getState().createProject(api, { mode: "scratch", name: "Stale" });
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveCreate({ project: { slug: "stale", name: "Stale" } });
    const created = await pending;

    expect(created).toBeNull();
    expect(useBoard.getState().projects).toEqual([]);
  });

  it("discards an in-flight task create that settles after the computer changes", async () => {
    let resolveCreate!: (value: unknown) => void;
    const api = {
      post: vi.fn(() => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
      get: vi.fn(async () => ({ tasks: [], nextCursor: null })),
    } as never;
    useBoard.setState({ cardsByProject: {}, error: null });

    const pending = useBoard.getState().createTask(api, "old-project", { title: "Stale task" });
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveCreate({
      task: {
        id: "task_stale",
        projectSlug: "old-project",
        title: "Stale task",
        status: "todo",
        priority: "normal",
        order: 0,
      },
    });
    const created = await pending;

    expect(created).toBeNull();
    expect(useBoard.getState().cardsByProject["old-project"]).toBeUndefined();
  });

  it("does not commit stale board mutation results after the computer changes", async () => {
    const card = {
      id: "task_old",
      projectSlug: "old-project",
      title: "Old task",
      description: "",
      status: "todo" as const,
      priority: "normal" as const,
      order: 0,
      parentTaskId: null,
      linkedSessionId: null,
      linkedWorktreeId: null,
      previewIds: [],
      tags: [],
      updatedAt: null,
      revision: null,
    };
    useBoard.setState({ cardsByProject: { "old-project": [card] }, error: null });
    let rejectDelete: ((err: unknown) => void) | undefined;
    const api = {
      delete: vi.fn(() => new Promise((_resolve, reject) => {
        rejectDelete = reject;
      })),
      get: vi.fn(async () => ({ tasks: [], nextCursor: null })),
      patch: vi.fn(async () => ({ task: card })),
    } as never;

    const pending = useBoard.getState().deleteTask(api, "old-project", "task_old");
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    // The per-task mutation queue starts the request on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectDelete?.(new Error("old runtime rejected"));
    await pending;

    // The failure belongs to the previous computer; the new board must not
    // inherit its error state.
    expect(useBoard.getState().error).toBeNull();
  });

  it("rejects a project response that settles after the computer changes", async () => {
    let resolveProjects!: (value: { projects: unknown[] }) => void;
    const api = {
      get: vi.fn(() => new Promise<{ projects: unknown[] }>((resolve) => {
        resolveProjects = resolve;
      })),
    } as never;

    const pending = useBoard.getState().loadProjects(api);
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveProjects({ projects: [{ slug: "old-project", name: "Old project" }] });
    await pending;

    expect(useBoard.getState()).toMatchObject({ projects: [], activeProjectSlug: null, error: null });
  });

  it("rejects stale session, terminal, Git, review, and preview loads", async () => {
    const resolvers = new Map<string, Array<(value: unknown) => void>>();
    const api = {
      get: vi.fn((path: string) => new Promise((resolve) => {
        resolvers.set(path, [...(resolvers.get(path) ?? []), resolve]);
      })),
    } as never;

    const sessionLoad = useSessions.getState().load(api);
    const shellLoad = useShellSessions.getState().load(api);
    const gitLoad = useGit.getState().loadAll(api, "old-project");
    const previewLoad = useGit.getState().loadPreviews(api, "old-project", "task_old");
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });

    for (const resolve of resolvers.get("/api/terminal/sessions") ?? []) resolve({ sessions: [{ name: "old" }] });
    for (const resolve of resolvers.get("/api/sessions") ?? []) resolve({ sessions: [], nextCursor: null });
    for (const resolve of resolvers.get("/api/projects/old-project/branches") ?? []) resolve({ branches: [{ name: "old" }] });
    for (const resolve of resolvers.get("/api/projects/old-project/prs") ?? []) resolve({ prs: [{ number: 1 }] });
    for (const resolve of resolvers.get("/api/projects/old-project/worktrees") ?? []) resolve({ worktrees: [{ id: "old" }] });
    for (const resolve of resolvers.get("/api/projects/old-project/previews?limit=100&taskId=task_old") ?? []) resolve({ previews: [{ id: "old" }] });
    await Promise.all([sessionLoad, shellLoad, gitLoad, previewLoad]);

    expect(useSessions.getState().sessions).toEqual([]);
    expect(useShellSessions.getState().sessions).toEqual([]);
    expect(useGit.getState()).toMatchObject({ branches: [], prs: [], worktrees: [], previews: [], previewScope: null });
  });
});
