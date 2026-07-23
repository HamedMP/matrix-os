// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useCodingAgentMessageQueue } from "../../desktop/src/renderer/src/features/coding-agents/message-queue-store";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useInspectorLayout } from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";

const NOW = "2026-07-12T12:00:00.000Z";

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

function workspaceFixture({ withThreads = true }: { withThreads?: boolean } = {}): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 2, attentionCount: 0 },
    tasks: { items: [], hasMore: false, limit: 100 },
    projectThreads: {
      items: withThreads
        ? [{
            id: "thread_plan",
            providerId: "codex",
            title: "Plan the auth work",
            status: "running",
            attention: "none",
            projectId: "matrix-os",
            createdAt: NOW,
            updatedAt: NOW,
          }]
        : [],
      hasMore: false,
      limit: 100,
    },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: NOW,
  };
}

function mockOperator({ withThreads = true }: { withThreads?: boolean } = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summaryFixture();
    if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
    if (channel === "runtime:get-notification-preferences") {
      return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    }
    if (channel === "runtime:get-project-workspace") return workspaceFixture({ withThreads });
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
    if (channel === "state:get") return { value: null };
    if (channel === "state:set" || channel === "state:set-panel-layout") return { ok: true };
    if (channel === "runtime:subscribe-thread-events" || channel === "runtime:unsubscribe-thread-events") {
      return { ok: true };
    }
    throw new Error(`unexpected channel ${channel}: ${JSON.stringify(payload)}`);
  });
  Object.defineProperty(window, "operator", {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined) },
  });
  return { invoke };
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
  useCodingAgentMessageQueue.setState({ queues: {} });
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

describe("ProjectChatsView hero empty state", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the hero with headline, composer, and suggestion chips when no chat is selected", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    // The new-chat composer sits inside the hero itself.
    expect(screen.getByLabelText("Agent run prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix a failing test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review my recent changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explore the codebase" })).toBeTruthy();
    // The rail and the type-to-start affordance survive the hero swap.
    expect(screen.getByRole("navigation", { name: "Project conversations" })).toBeTruthy();
    expect(screen.getByText("Start typing to begin a new chat")).toBeTruthy();
    // The old picker-style empty state is gone.
    expect(screen.queryByText("Select a chat")).toBeNull();
  });

  it("keeps the rail visible and swaps only the conversation pane when threads exist but none is selected", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);

    // The first listed chat auto-selects, so the hero stays hidden.
    const row = await screen.findByRole("button", { name: "Chat Plan the auth work" });
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    expect(screen.queryByText("What should we work on?")).toBeNull();

    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });

    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chat Plan the auth work" })).toBe(row);
  });

  it("seeds the hero composer prompt when a suggestion chip is clicked", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByText("What should we work on?");

    fireEvent.click(screen.getByRole("button", { name: "Review my recent changes" }));

    const prompt = (await screen.findByLabelText("Agent run prompt")) as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe("Review my recent changes"));
    // The chip opens the composer in place — never a second inspector copy.
    expect(screen.getAllByLabelText("Agent run prompt")).toHaveLength(1);
  });

  it("never mounts a duplicate composer in the inspector while the hero is visible", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByText("What should we work on?");

    // Even after a type-to-start seed opens the composer, only the hero's
    // instance exists.
    await act(async () => {});
    fireEvent.keyDown(window, { key: "h" });

    await waitFor(() => {
      expect(screen.getAllByLabelText("Agent run prompt")).toHaveLength(1);
    });
    const prompt = screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe("h"));
  });
});
