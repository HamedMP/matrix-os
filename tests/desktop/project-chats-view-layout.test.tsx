// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useInspectorLayout } from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";

const NOW = "2026-07-12T12:00:00.000Z";

// Capture the resizable-panels wiring instead of relying on jsdom layout.
const panelsMock = vi.hoisted(() => ({
  lastDefaultLayout: undefined as Record<string, number> | undefined,
  lastOnLayoutChange: undefined as ((layout: Record<string, number>) => void) | undefined,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, defaultLayout, onLayoutChange, className }: {
    children: React.ReactNode;
    defaultLayout?: Record<string, number>;
    onLayoutChange?: (layout: Record<string, number>) => void;
    className?: string;
  }) => {
    panelsMock.lastDefaultLayout = defaultLayout;
    panelsMock.lastOnLayoutChange = onLayoutChange;
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
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useInspectorLayout.setState({ entries: {}, runtimeScope: null });
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
}

describe("ProjectChatsView hero layout", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    panelsMock.lastDefaultLayout = undefined;
    panelsMock.lastOnLayoutChange = undefined;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the conversation and inspector in a resizable split by default", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByTestId("inspector-split")).toBeTruthy();
    expect(screen.getByTestId("panel-conversation")).toBeTruthy();
    expect(screen.getByTestId("panel-inspector")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    // The inspector starts open at the default width with a visible toggle.
    expect(panelsMock.lastDefaultLayout).toEqual({ conversation: 66, inspector: 34 });
    expect(screen.getByRole("complementary", { name: "Conversation tools" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Hide conversation tools" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses to a full-width hero transcript and persists the choice", async () => {
    const { saved } = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    fireEvent.click(await screen.findByRole("button", { name: "Hide conversation tools" }));

    expect(screen.queryByTestId("inspector-split")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Conversation tools" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show conversation tools" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => {
      expect(saved.some((entry) =>
        entry.taskKey === "project-inspector:matrix-os" && entry.layout.visible.inspector === false,
      )).toBe(true);
    });

    // Expanding restores the inspector without losing the conversation.
    fireEvent.click(toggle);
    expect(await screen.findByTestId("inspector-split")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Conversation tools" })).toBeTruthy();
  });

  it("restores a persisted collapsed inspector for the project", async () => {
    mockOperator({
      "project-inspector:matrix-os": {
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

  it("persists inspector width changes from the split", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByTestId("inspector-split");

    act(() => {
      panelsMock.lastOnLayoutChange?.({ conversation: 55, inspector: 45 });
    });

    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(45);
  });

  it("keeps layouts independent per project", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByTestId("inspector-split");

    act(() => {
      panelsMock.lastOnLayoutChange?.({ conversation: 50, inspector: 50 });
    });

    expect(useInspectorLayout.getState().layoutFor("matrix-os").widthPct).toBe(50);
    expect(useInspectorLayout.getState().layoutFor("website").widthPct).toBe(34);
  });
});
