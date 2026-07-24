// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    providers: [
      {
        id: "codex",
        kind: "codex",
        displayName: "Codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "plan"],
        defaultMode: "default",
        setupActions: [],
      },
      {
        id: "claude",
        kind: "claude",
        displayName: "Claude",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "review"],
        defaultMode: "review",
        setupActions: [],
      },
    ],
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

function createdThreadSnapshot(prompt: string, providerId: string) {
  return {
    thread: {
      id: "thread_picked",
      providerId,
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

function mockOperator({ preferredProviderId }: { preferredProviderId?: string } = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summaryFixture();
    if (channel === "runtime:get-reviews") return { items: [], hasMore: false, limit: 50 };
    if (channel === "runtime:get-notification-preferences") {
      return { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    }
    if (channel === "runtime:get-project-workspace") return workspaceFixture();
    if (channel === "runtime:create-thread") {
      const request = payload as { prompt?: string; providerId?: string };
      return createdThreadSnapshot(request.prompt ?? "New chat", request.providerId ?? "codex");
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
    if (channel === "state:get") {
      const { key } = payload as { key?: string };
      if (key === "providerPreferences") {
        return { value: preferredProviderId ? { defaultProviderId: preferredProviderId } : null };
      }
      return { value: null };
    }
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

async function openDraftComposer() {
  render(<ProjectChatsView projectId="matrix-os" active />);
  await screen.findByRole("region", { name: "Conversation Plan the auth work" });
  fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
  await screen.findByLabelText("Message new chat");
}

describe("composer provider/mode pickers", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders provider and mode pickers inside the draft composer bar with contract defaults", async () => {
    mockOperator();
    await openDraftComposer();

    const provider = (await screen.findByLabelText("Agent provider")) as HTMLSelectElement;
    const mode = screen.getByLabelText("Agent mode") as HTMLSelectElement;
    expect(provider.value).toBe("codex");
    expect(mode.value).toBe("default");
    // The pickers sit inside the floating composer card, Codex-style.
    expect(provider.closest(".prompt-card")).not.toBeNull();
    expect(mode.closest(".prompt-card")).not.toBeNull();
    // Draft pickers are editable.
    expect(provider.disabled).toBe(false);
    expect(mode.disabled).toBe(false);
  });

  it("defaults the draft provider to the persisted provider preference", async () => {
    mockOperator({ preferredProviderId: "claude" });
    await openDraftComposer();

    const provider = (await screen.findByLabelText("Agent provider")) as HTMLSelectElement;
    const mode = screen.getByLabelText("Agent mode") as HTMLSelectElement;
    await waitFor(() => expect(provider.value).toBe("claude"));
    // The mode follows the preferred provider's default mode.
    await waitFor(() => expect(mode.value).toBe("review"));
  });

  it("resets the mode to the new provider's default when the provider changes", async () => {
    mockOperator();
    await openDraftComposer();

    const provider = (await screen.findByLabelText("Agent provider")) as HTMLSelectElement;
    // Pick a non-default mode first so the reset is observable.
    fireEvent.change(screen.getByLabelText("Agent mode"), { target: { value: "plan" } });
    fireEvent.change(provider, { target: { value: "claude" } });

    const mode = screen.getByLabelText("Agent mode") as HTMLSelectElement;
    expect(provider.value).toBe("claude");
    expect(mode.value).toBe("review");
    // The new provider's modes replace the old provider's options.
    expect(Array.from(mode.options).map((option) => option.value)).toEqual(["default", "review"]);
  });

  it("sends the picked provider and mode with the created thread", async () => {
    const { invoke } = mockOperator();
    await openDraftComposer();

    fireEvent.change(await screen.findByLabelText("Agent provider"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Agent mode"), { target: { value: "default" } });
    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Use the picked provider" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ providerId: "claude", mode: "default", prompt: "Use the picked provider" }),
      );
    });
  });

  it("shows the thread provider as a display-only picker and no mode picker in a live thread", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });

    const composer = (await screen.findByLabelText("Message conversation")) as HTMLTextAreaElement;
    const provider = (await screen.findByLabelText("Agent provider")) as HTMLSelectElement;
    expect(provider.value).toBe("codex");
    // Turns cannot change provider or mode (CreateAgentTurnRequest carries only
    // message/attachments/clientRequestId), so the picker is display-only and
    // no mode picker is offered in a thread.
    expect(provider.disabled).toBe(true);
    expect(provider.closest(".prompt-card")).not.toBeNull();
    expect(screen.queryByLabelText("Agent mode")).toBeNull();
    expect(composer).toBeTruthy();
  });
});
