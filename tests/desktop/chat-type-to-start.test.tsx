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

describe("ProjectChatsView type-to-start", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a type-to-start hint when no chat is selected", async () => {
    // A threadless project has nothing to autoselect, so the empty Chats
    // state (and the type-to-start affordance) persists.
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);

    expect(await screen.findByText("Start typing to begin a new chat")).toBeTruthy();
  });

  it("opens the draft composer seeded with the first typed character", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByText("Start typing to begin a new chat");
    // Flush passive effects so the window keydown listener is attached.
    await act(async () => {});

    fireEvent.keyDown(window, { key: "h" });

    const prompt = (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe("h"));
  });

  it("replaces the selected chat with a seeded draft when typing starts", async () => {
    mockOperator();
    useProjectView.getState().setSelectedThread("matrix-os", "thread_plan");
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    await act(async () => {});

    fireEvent.keyDown(window, { key: "h" });

    // Codex-style: typing swaps the conversation for the draft composer,
    // seeded with the first character, instead of ignoring the key.
    const prompt = (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe("h"));
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    expect(screen.queryByRole("region", { name: "Conversation Plan the auth work" })).toBeNull();
  });

  it("ignores keys typed into an editable element", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByText("Start typing to begin a new chat");
    await act(async () => {});

    const foreign = document.createElement("input");
    document.body.appendChild(foreign);
    try {
      fireEvent.keyDown(foreign, { key: "h" });
    } finally {
      foreign.remove();
    }

    // The draft composer is always rendered while no chat is selected; typing
    // into another editable element must not seed it.
    expect((screen.getByLabelText("Message new chat") as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores modified and non-printable keys", async () => {
    mockOperator({ withThreads: false });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByText("Start typing to begin a new chat");
    await act(async () => {});

    fireEvent.keyDown(window, { key: "h", metaKey: true });
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });

    // The draft composer is always rendered while no chat is selected;
    // modified or non-printable keys must not seed it.
    expect((screen.getByLabelText("Message new chat") as HTMLTextAreaElement).value).toBe("");
  });
});
