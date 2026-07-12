import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDesktopRuntimeChange } from "../../desktop/src/renderer/src/stores/runtime-transition";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
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
    expect(useTabs.getState()).toMatchObject({ tabs: [], activeTabId: null });
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
