// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import {
  taskKeyFor,
  useInspectorLayout,
} from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";
import { codingAgentRuntimeScope } from "../../desktop/src/shared/coding-agent-project-workspace";

// Inspector layouts are keyed per runtime so two computers holding the same
// project id cannot read or overwrite each other's state.
const RUNTIME_SCOPE = codingAgentRuntimeScope({
  handle: "operator",
  platformHost: "https://platform.test",
  runtimeSlot: "primary",
});
const INSPECTOR_TASK_KEY = taskKeyFor(RUNTIME_SCOPE, "matrix-os");
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { clearDraftChats } from "../../desktop/src/renderer/src/stores/draft-chat";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const NOW = "2026-07-12T12:00:00.000Z";

// Capture the resizable-panels wiring instead of relying on jsdom layout.
const panelsMock = vi.hoisted(() => ({
  lastDefaultLayout: undefined as Record<string, number> | undefined,
  lastOnLayoutChange: undefined as ((layout: Record<string, number>) => void) | undefined,
  lastOrientation: undefined as "horizontal" | "vertical" | undefined,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, defaultLayout, onLayoutChange, className, orientation }: {
    children: React.ReactNode;
    defaultLayout?: Record<string, number>;
    onLayoutChange?: (layout: Record<string, number>) => void;
    className?: string;
    orientation: "horizontal" | "vertical";
  }) => {
    const initialLayout = React.useRef(defaultLayout);
    panelsMock.lastDefaultLayout = initialLayout.current;
    panelsMock.lastOnLayoutChange = onLayoutChange;
    panelsMock.lastOrientation = orientation;
    return <div data-testid="inspector-split" className={className}>{children}</div>;
  },
  Panel: ({ children, id, className }: { children: React.ReactNode; id?: string; className?: string }) => (
    <div data-testid={`panel-${id ?? "unknown"}`} className={className}>{children}</div>
  ),
  Separator: ({ className }: { className?: string }) => (
    <div role="separator" aria-orientation="vertical" className={className} />
  ),
}));

function summaryFixture(): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsThreadCreate", enabled: true },
      { id: "codingAgentsSameThreadTurns", enabled: true },
      { id: "codingAgentsReview", enabled: true },
      { id: "codingAgentsProjectWorkspace", enabled: true },
    ],
    providers: [{
      id: "codex",
      kind: "codex",
      displayName: "Codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default"],
      defaultMode: "default",
      setupActions: [],
    }],
    projects: {
      items: [{ id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

function workspaceFixture(): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 },
    tasks: { items: [], hasMore: false, limit: 100 },
    projectThreads: {
      items: [{
        id: "thread_plan",
        providerId: "codex",
        title: "Plan the auth work",
        status: "running",
        attention: "none",
        projectId: "matrix-os",
        createdAt: NOW,
        updatedAt: NOW,
      }],
      hasMore: false,
      limit: 100,
    },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: NOW,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface SavedLayout {
  taskKey: string;
  layout: { visible: Record<string, boolean>; sizes: Record<string, number> };
}

function mockOperator(panelLayouts: Record<string, unknown> = {}) {
  const saved: SavedLayout[] = [];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summaryFixture();
    if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
    if (channel === "runtime:get-notification-preferences") {
      return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    }
    if (channel === "runtime:get-project-workspace") return workspaceFixture();
    if (channel === "runtime:get-thread-snapshot") {
      const { threadId } = payload as { threadId: string };
      return {
        thread: {
          id: threadId,
          providerId: "codex",
          title: "Plan the auth work",
          status: "running",
          attention: "none",
          projectId: "matrix-os",
          createdAt: NOW,
          updatedAt: NOW,
        },
        events: { items: [], hasMore: false, limit: 200 },
      };
    }
    if (channel === "state:get") {
      const { key } = payload as { key: string };
      if (key === "panelLayouts") return { value: panelLayouts };
      return { value: null };
    }
    if (channel === "state:set") return { ok: true };
    if (channel === "state:set-panel-layout") {
      saved.push(payload as SavedLayout);
      return { ok: true };
    }
    if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
      return { ok: true };
    }
    throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return { invoke, saved };
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function resetStores() {
  clearDraftChats();
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useTabs.setState(useTabs.getInitialState(), true);
  useInspectorLayout.setState({ entries: {}, runtimeScope: null, hydratedScope: null });
  useCodingAgentWorkspace.setState({
    status: "idle",
    summary: null,
    summaryRevision: 0,
    error: null,
    reviewsStatus: "idle",
    reviews: null,
    reviewsError: null,
    threadSnapshotStatus: "idle",
    threadSnapshot: null,
    threadSnapshotError: null,
    activeThreadId: null,
    notificationPreferencesStatus: "idle",
    notificationPreferences: null,
    createStatus: "idle",
    createError: null,
  });
  useConnection.setState({
    status: "signed-in",
    handle: "operator",
    platformHost: "https://platform.test",
    runtimeSlot: "primary",
    api: null,
  });
  useHermesChat.setState(useHermesChat.getInitialState(), true);
}

async function openInspector(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Show conversation tools" }));
  await screen.findByTestId("inspector-split");
}

describe("ProjectChatsView hero layout", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    panelsMock.lastDefaultLayout = undefined;
    panelsMock.lastOnLayoutChange = undefined;
    panelsMock.lastOrientation = undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the conversation full width until contextual tools are requested", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByRole("button", { name: "Show conversation tools" })).toBeTruthy();
    expect(screen.queryByTestId("inspector-split")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show conversation tools" }));

    expect(await screen.findByTestId("inspector-split")).toBeTruthy();
    expect(screen.getByTestId("panel-conversation")).toBeTruthy();
    expect(screen.getByTestId("panel-inspector")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(panelsMock.lastDefaultLayout).toEqual({ conversation: 66, inspector: 34 });
    expect(screen.getByRole("complementary", { name: "Conversation tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close conversation tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize conversation tools" })).toBeTruthy();
  });

  it("maximizes the contextual workbench without unmounting the conversation", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    fireEvent.click(await screen.findByRole("button", { name: "Show conversation tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Maximize conversation tools" }));

    expect(await screen.findByTestId("inspector-maximized")).toBeTruthy();
    expect(screen.getByTestId("conversation-underlay")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore conversation tools" })).toBeTruthy();
    expect(useInspectorLayout.getState().layoutFor("matrix-os").maximized).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Restore conversation tools" }));
    expect(await screen.findByTestId("inspector-split")).toBeTruthy();
  });

  it("hides the inspector entirely while the draft pane is showing", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByRole("button", { name: "Show conversation tools" })).toBeTruthy();

    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });

    // Draft state: the hero takes the full width — no inspector panel, no
    // split, and no collapse toggle.
    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    expect(screen.queryByTestId("inspector-split")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide conversation tools" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show conversation tools" })).toBeNull();
  });

  it("keeps contextual tools closed when a thread is selected from the rail", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Show conversation tools" });

    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });
    await screen.findByText("What should we work on?");
    expect(screen.queryByTestId("inspector-split")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));

    expect(await screen.findByRole("button", { name: "Show conversation tools" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();
  });

  it("shows project-bound Global Chats in the same rail and opens the shared chat surface", async () => {
    mockOperator();
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/api/conversations/conversation-project")) {
        return {
          id: "conversation-project",
          createdAt: 10,
          updatedAt: 20,
          context: {
            projectId: "matrix-os",
            projectName: "Matrix OS",
            projectKind: "github",
            status: "ready",
          },
          totalCount: 1,
          messages: [{ index: 0, role: "user", content: "Project launch plan", contentTruncated: false, timestamp: 10 }],
          hasMore: false,
          limit: 50,
        };
      }
      throw new Error(`unexpected api path ${path}`);
    });
    useConnection.setState({ api: { get } as never });
    useHermesChat.setState({
      indexStatus: "ready",
      conversations: [{
        id: "conversation-project",
        title: "Release plan",
        preview: "Project launch plan",
        messageCount: 1,
        createdAt: 10,
        updatedAt: 20,
        context: {
          projectId: "matrix-os",
          projectName: "Matrix OS",
          projectKind: "github",
          status: "ready",
        },
      }],
    });

    render(<ProjectChatsView projectId="matrix-os" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat Release plan" }));

    expect(await screen.findByRole("region", { name: "Hermes conversation" })).toBeTruthy();
    expect(await screen.findByText("Project launch plan")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();
  });

  it("keeps a Chat visible in its Project when an older index refresh settles after the move", async () => {
    mockOperator();
    const staleContext = {
      projectId: "legacy-project",
      projectName: "Legacy project",
      projectKind: "folder" as const,
      repositoryLabel: "legacy-project",
      status: "unavailable" as const,
    };
    const projectContext = {
      projectId: "matrix-os",
      projectName: "Matrix OS",
      projectKind: "github" as const,
      repositoryLabel: "FinnaAI/matrix-os",
      status: "ready" as const,
    };
    const pendingIndex = deferred<unknown>();
    let conversationIndexRequests = 0;
    const api = {
      get: vi.fn((path: string) => {
        if (path !== "/api/conversations") {
          throw new Error(`unexpected api path ${path}`);
        }
        conversationIndexRequests += 1;
        if (conversationIndexRequests === 1) return pendingIndex.promise;
        return Promise.resolve([{
          id: "conversation-project",
          preview: "Project launch plan",
          messageCount: 1,
          createdAt: 10,
          updatedAt: 20,
          context: projectContext,
        }]);
      }),
      patch: vi.fn().mockResolvedValue({ context: projectContext }),
    } as never;
    useConnection.setState({ api });
    useHermesChat.setState({
      sessionId: "conversation-project",
      view: "conversation",
      conversations: [{
        id: "conversation-project",
        title: "Release plan",
        preview: "Project launch plan",
        messageCount: 1,
        createdAt: 10,
        updatedAt: 20,
        context: staleContext,
      }],
      conversationContext: staleContext,
      contextStatus: "ready",
      indexStatus: "ready",
    });

    const refresh = useHermesChat.getState().refreshConversations(api);
    await expect(useHermesChat.getState().updateConversationContext(
      api,
      "conversation-project",
      "matrix-os",
    )).resolves.toBe(true);
    pendingIndex.resolve([{
      id: "conversation-project",
      preview: "Project launch plan",
      messageCount: 1,
      createdAt: 10,
      updatedAt: 20,
      context: staleContext,
    }]);
    await refresh;

    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByRole("button", { name: "Chat Project launch plan" })).toBeTruthy();
  });

  it("refreshes an already-ready Chat index when its Project becomes active", async () => {
    mockOperator();
    const get = vi.fn(async (path: string) => {
      if (path === "/api/conversations") {
        return [{
          id: "conversation-project",
          preview: "Project launch plan",
          messageCount: 1,
          createdAt: 10,
          updatedAt: 20,
          context: {
            projectId: "matrix-os",
            projectName: "Matrix OS",
            projectKind: "github",
            repositoryLabel: "FinnaAI/matrix-os",
            status: "ready",
          },
        }];
      }
      throw new Error(`unexpected api path ${path}`);
    });
    useConnection.setState({ api: { get } as never });
    useHermesChat.setState({
      indexStatus: "ready",
      conversations: [],
    });

    render(<ProjectChatsView projectId="matrix-os" active />);

    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/conversations"));
    await waitFor(() => expect(useHermesChat.getState().conversations).toEqual([
      expect.objectContaining({ id: "conversation-project" }),
    ]));
    expect(await screen.findByRole("button", { name: "Chat Project launch plan" })).toBeTruthy();
  });

  it("does not record a rail selection when its snapshot fails to load", async () => {
    mockOperator();
    const loadThreadSnapshot = vi.fn(async (threadId: string) => {
      useCodingAgentWorkspace.setState({
        activeThreadId: threadId,
        threadSnapshotStatus: "error",
        threadSnapshot: null,
        threadSnapshotError: "Thread state unavailable",
      });
    });
    useCodingAgentWorkspace.setState({ loadThreadSnapshot });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Show conversation tools" });
    act(() => useProjectView.getState().setSelectedThread("matrix-os", null));
    await screen.findByText("What should we work on?");
    loadThreadSnapshot.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));

    await waitFor(() => expect(loadThreadSnapshot).toHaveBeenCalledWith("thread_plan"));
  });

  it("does not bind a cached workspace terminal while the selected thread snapshot is loading", async () => {
    const { invoke } = mockOperator();
    const defaultInvoke = invoke.getMockImplementation()!;
    const pendingSnapshot = new Promise<never>(() => undefined);
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === "runtime:get-summary") {
        return {
          ...summaryFixture(),
          terminalSessions: {
            items: [{
              id: "term_cached",
              name: "cached-shell",
              status: "running",
              attachable: true,
              createdAt: NOW,
              updatedAt: NOW,
            }],
            hasMore: false,
            limit: 20,
          },
        };
      }
      if (channel === "runtime:get-project-workspace") {
        const workspace = workspaceFixture();
        return {
          ...workspace,
          projectThreads: {
            ...workspace.projectThreads,
            items: workspace.projectThreads.items.map((thread) => ({
              ...thread,
              terminalSessionId: "term_cached",
            })),
          },
        };
      }
      if (channel === "runtime:get-thread-snapshot") return pendingSnapshot;
      return defaultInvoke(channel, payload);
    });

    useProjectView.getState().setSelectedThread("matrix-os", "thread_plan");
    render(<ProjectChatsView projectId="matrix-os" active />);

    await openInspector();
    fireEvent.click(await screen.findByRole("tab", { name: /^Terminal\b/ }));

    expect(await screen.findByText("This chat has no linked terminal session.")).toBeTruthy();
    expect(screen.queryByText("cached-shell")).toBeNull();
  });

  it("collapses to a full-width hero transcript and persists the choice", async () => {
    const { saved } = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    await openInspector();
    fireEvent.click(screen.getByRole("button", { name: "Close conversation tools" }));

    expect(screen.queryByTestId("inspector-split")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show conversation tools" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => {
      expect(saved.some((entry) =>
        entry.taskKey === INSPECTOR_TASK_KEY && entry.layout.visible.inspector === false,
      )).toBe(true);
    });

    // Expanding restores the inspector without losing the conversation.
    fireEvent.click(toggle);
    expect(await screen.findByTestId("inspector-split")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Conversation tools" })).toBeTruthy();
  });

  it("restores a persisted collapsed inspector for the project", async () => {
    mockOperator({
      [INSPECTOR_TASK_KEY]: {
        order: ["conversation", "inspector"],
        visible: { conversation: true, inspector: false },
        sizes: { conversation: 60, inspector: 40 },
        touchedAt: 1,
      },
    });
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByRole("button", { name: "Show conversation tools" })).toBeTruthy();
    expect(screen.queryByTestId("inspector-split")).toBeNull();

    // Re-expanding keeps the persisted width.
    fireEvent.click(screen.getByRole("button", { name: "Show conversation tools" }));
    await screen.findByTestId("inspector-split");
    expect(panelsMock.lastDefaultLayout).toEqual({ conversation: 60, inspector: 40 });
  });

  it("applies a persisted expanded width before mounting the split", async () => {
    mockOperator({
      [INSPECTOR_TASK_KEY]: {
        order: ["conversation", "inspector"],
        visible: { conversation: true, inspector: true },
        sizes: { conversation: 50, inspector: 50 },
        touchedAt: 1,
      },
    });

    render(<ProjectChatsView projectId="matrix-os" active />);

    await screen.findByTestId("inspector-split");
    expect(panelsMock.lastDefaultLayout).toEqual({ conversation: 50, inspector: 50 });
  });

  it("reopens a collapsed inspector when a review-focus request arrives", async () => {
    mockOperator({
      [INSPECTOR_TASK_KEY]: {
        order: ["conversation", "inspector"],
        visible: { conversation: true, inspector: false },
        sizes: { conversation: 60, inspector: 40 },
        touchedAt: 1,
      },
    });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("button", { name: "Show conversation tools" });

    act(() => useCodingAgentWorkspace.setState({ reviewFocusRequestId: 1, reviewFocusConsumedId: 0 }));

    expect(await screen.findByRole("button", { name: "Close conversation tools" })).toBeTruthy();
    expect(useInspectorLayout.getState().layoutFor("matrix-os").collapsed).toBe(false);
  });

  it("stacks the conversation and inspector in narrow desktop windows", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    mockOperator();

    render(<ProjectChatsView projectId="matrix-os" active />);

    await openInspector();
    expect(panelsMock.lastOrientation).toBe("vertical");
    expect(panelsMock.lastDefaultLayout).toEqual({ conversation: 55, inspector: 45 });
  });

  it("persists inspector width changes from the split", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await openInspector();

    act(() => {
      panelsMock.lastOnLayoutChange?.({ conversation: 55, inspector: 45 });
    });

    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(45);
  });

  it("keeps layouts independent per project", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await openInspector();

    act(() => {
      panelsMock.lastOnLayoutChange?.({ conversation: 50, inspector: 50 });
    });

    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(50);
    expect(useInspectorLayout.getState().layoutFor("website").widthPct).toBe(34);
  });
});
