// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useCodingAgentMessageQueue } from "../../desktop/src/renderer/src/features/coding-agents/message-queue-store";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
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
      supportedModes: ["default", "plan"],
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

function createdThreadSnapshot(prompt: string) {
  return {
    thread: {
      id: "thread_new_draft",
      providerId: "codex",
      title: prompt.slice(0, 40),
      status: "queued",
      attention: "none",
      projectId: "matrix-os",
      createdAt: NOW,
      updatedAt: NOW,
    },
    events: { items: [], hasMore: false, limit: 200 },
  };
}

function mockOperator({ createImpl }: {
  createImpl?: (payload: unknown) => Promise<unknown>;
} = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summaryFixture();
    if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
    if (channel === "runtime:get-notification-preferences") {
      return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    }
    if (channel === "runtime:get-project-workspace") return workspaceFixture();
    if (channel === "runtime:create-thread") {
      if (createImpl) return createImpl(payload);
      return createdThreadSnapshot((payload as { prompt?: string }).prompt ?? "New chat");
    }
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
  useProviderPreferences.setState({ defaultProviderId: null, hydrated: false });
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

async function openDraft() {
  render(<ProjectChatsView projectId="matrix-os" active />);
  await screen.findByRole("region", { name: "Conversation Plan the auth work" });
  fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
  return (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;
}

describe("draft chat implicit thread creation", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates and selects the thread when the draft is sent with the Send button", async () => {
    const { invoke } = mockOperator();
    const composer = await openDraft();

    fireEvent.change(composer, { target: { value: "Investigate the flaky desktop check" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({
          providerId: "codex",
          mode: "default",
          prompt: "Investigate the flaky desktop check",
          projectId: "matrix-os",
          clientRequestId: expect.stringMatching(/^req_desktop_/),
        }),
      );
    });
    // The created thread replaces the draft in place.
    await waitFor(() => {
      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_new_draft");
    });
    expect(await screen.findByRole("region", { name: /Conversation/ })).toBeTruthy();
    expect(screen.queryByLabelText("Message new chat")).toBeNull();
    // The rail refreshes so the new thread appears in the list.
    await waitFor(() => {
      const workspaceCalls = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "runtime:get-project-workspace");
      expect(workspaceCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("creates the thread when Enter is pressed in the draft composer", async () => {
    const { invoke } = mockOperator();
    const composer = await openDraft();

    fireEvent.change(composer, { target: { value: "Summarize the release notes" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ prompt: "Summarize the release notes" }),
      );
    });
    await waitFor(() => {
      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_new_draft");
    });
  });

  it("resolves the project relation lazily when the draft was typed without a seed", async () => {
    const { invoke } = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    // Deselect without going through the + button: no seed, no relation.
    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });
    const composer = (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "Direct draft with no seed" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ prompt: "Direct draft with no seed", projectId: "matrix-os" }),
      );
    });
  });

  it("disables send while the create is in flight and never issues a duplicate create", async () => {
    let resolveCreate: (value: unknown) => void = () => undefined;
    const { invoke } = mockOperator({
      createImpl: () => new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    });
    const composer = await openDraft();

    fireEvent.change(composer, { target: { value: "Wait for me" } });
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);

    await waitFor(() => {
      expect(send.hasAttribute("disabled")).toBe(true);
    });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.click(send);

    const createCalls = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "runtime:create-thread");
    expect(createCalls).toHaveLength(1);

    resolveCreate(createdThreadSnapshot("Wait for me"));
    await waitFor(() => {
      expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_new_draft");
    });
  });

  it("keeps the draft text and shows a safe generic error when the create fails", async () => {
    mockOperator({
      createImpl: () => Promise.reject(new Error("provider failed on /home/matrix/private with token secret")),
    });
    const composer = await openDraft();

    fireEvent.change(composer, { target: { value: "Keep this draft text" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Agent run could not be started. Try again.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
    // The draft survives the failure so the user can retry.
    expect(composer.value).toBe("Keep this draft text");
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
  });
});
