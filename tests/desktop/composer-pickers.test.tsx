// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useInspectorLayout } from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { clearDraftChats, useDraftChat } from "../../desktop/src/renderer/src/stores/draft-chat";
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

function piFirstSummaryFixture(): RuntimeSummary {
  const summary = summaryFixture();
  return {
    ...summary,
    providers: [
      {
        id: "pi",
        kind: "pi",
        displayName: "Pi",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
      ...summary.providers,
    ],
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

function mockOperator({
  preferredProviderId,
  loadPreferredProviderId,
  threadProviderId = "codex",
  summary = summaryFixture(),
}: {
  preferredProviderId?: string;
  loadPreferredProviderId?: () => Promise<string | null>;
  threadProviderId?: string;
  summary?: RuntimeSummary;
} = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summary;
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
          providerId: threadProviderId,
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
        const providerId = loadPreferredProviderId
          ? await loadPreferredProviderId()
          : preferredProviderId ?? null;
        return { value: providerId ? { defaultProviderId: providerId } : null };
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
  clearDraftChats();
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {} });
  useProjectChatLauncher.setState({ composerRequest: null });
  useInspectorLayout.setState({ entries: {}, runtimeScope: null });
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

function selectedProviderInstance(): string | null {
  return screen.getByRole("button", { name: "Choose model and provider" })
    .getAttribute("data-provider-instance");
}

async function chooseProvider(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  fireEvent.click(screen.getByRole("button", {
    name: `${label === "Claude" ? "Claude Code" : label} harness, Available`,
  }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`Provider default.*${label}.*Available`) }));
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

  it("renders provider, effort, and permission controls inside the draft composer bar", async () => {
    mockOperator();
    await openDraftComposer();

    const provider = await screen.findByRole("button", { name: "Choose model and provider" });
    const effort = screen.getByRole("button", { name: "Reasoning" });
    const permission = screen.getByRole("button", { name: "Permission mode" });
    expect(selectedProviderInstance()).toBe("codex_default");
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    // The controls sit inside the floating composer card, Codex-style.
    expect(provider.closest(".prompt-card")).not.toBeNull();
    expect(effort.closest(".prompt-card")).not.toBeNull();
    expect(permission.closest(".prompt-card")).not.toBeNull();
    // Draft pickers are editable.
    expect(provider.getAttribute("aria-expanded")).toBe("false");
    expect(effort.getAttribute("aria-expanded")).toBe("false");
    expect(permission.getAttribute("aria-expanded")).toBe("false");
  });

  it("defaults the draft provider to the persisted provider preference", async () => {
    mockOperator({ preferredProviderId: "claude" });
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(selectedProviderInstance()).toBe("claude_code_default"));
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
  });

  it("ignores an unready persisted provider when choosing the draft default", async () => {
    const summary = summaryFixture();
    const unreadySummary: RuntimeSummary = {
      ...summary,
      providers: summary.providers.map((provider) => provider.id === "claude"
        ? { ...provider, availability: "auth_required", authStatus: "expired" }
        : provider),
    };
    mockOperator({ preferredProviderId: "claude", summary: unreadySummary });
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(selectedProviderInstance()).toBe("codex_default"));
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
  });

  it("uses the preferred non-pi provider sandbox when pi is the runtime default", async () => {
    const { invoke } = mockOperator({
      preferredProviderId: "codex",
      summary: piFirstSummaryFixture(),
    });
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(selectedProviderInstance()).toBe("codex_default"));
    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Use my preferred provider" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ providerId: "codex", sandboxMode: "workspace_write" }),
      );
    });
  });

  it("applies a persisted provider that hydrates after a seeded draft opens", async () => {
    let resolvePreference!: (value: string | null) => void;
    mockOperator({
      loadPreferredProviderId: () => new Promise((resolve) => {
        resolvePreference = resolve;
      }),
    });
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    expect(selectedProviderInstance()).toBe("codex_default");
    await act(async () => {
      resolvePreference("claude");
      await Promise.resolve();
    });

    await waitFor(() => expect(selectedProviderInstance()).toBe("claude_code_default"));
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
  });

  it("persists the hydrated provider when a prompt is typed before preferences load", async () => {
    let resolvePreference!: (value: string | null) => void;
    const { invoke } = mockOperator({
      loadPreferredProviderId: () => new Promise((resolve) => {
        resolvePreference = resolve;
      }),
    });
    await openDraftComposer();

    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep the hydrated provider" } });
    await act(async () => {
      resolvePreference("claude");
      await Promise.resolve();
    });

    await waitFor(() => expect(selectedProviderInstance()).toBe("claude_code_default"));
    await waitFor(() => expect(useDraftChat.getState().draftFor("matrix-os")).toMatchObject({
      providerId: "claude",
      mode: "review",
      prompt: "Keep the hydrated provider",
    }));

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));

    const restored = (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;
    expect(selectedProviderInstance()).toBe("claude_code_default");
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ providerId: "claude", mode: "review", prompt: "Keep the hydrated provider" }),
      );
    });
  });

  it("restores an untouched draft with the provider preference that hydrates while it is closed", async () => {
    let resolvePreference!: (value: string | null) => void;
    const { invoke } = mockOperator({
      loadPreferredProviderId: () => new Promise((resolve) => {
        resolvePreference = resolve;
      }),
    });
    await openDraftComposer();

    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep my prompt, not the transient provider" } });
    await waitFor(() => expect(useDraftChat.getState().draftFor("matrix-os")?.prompt).toBe(
      "Keep my prompt, not the transient provider",
    ));

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    await act(async () => {
      resolvePreference("claude");
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));

    const restored = (await screen.findByLabelText("Message new chat")) as HTMLTextAreaElement;
    await waitFor(() => expect(selectedProviderInstance()).toBe("claude_code_default"));
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    expect(restored.value).toBe("Keep my prompt, not the transient provider");
    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({
          providerId: "claude",
          mode: "review",
          prompt: "Keep my prompt, not the transient provider",
        }),
      );
    });
  });

  it("uses the new provider's default execution mode without exposing the legacy mode picker", async () => {
    mockOperator();
    await openDraftComposer();

    await chooseProvider("Claude");

    expect(selectedProviderInstance()).toBe("claude_code_default");
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    await waitFor(() => expect(useDraftChat.getState().draftFor("matrix-os")).toMatchObject({
      providerId: "claude",
      mode: "review",
    }));
  });

  it("updates the sandbox when switching from pi to a non-pi provider", async () => {
    const { invoke } = mockOperator({ summary: piFirstSummaryFixture() });
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    expect(selectedProviderInstance()).toBe("pi_default");
    await chooseProvider("Codex");
    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Switch providers safely" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ providerId: "codex", sandboxMode: "workspace_write" }),
      );
    });
  });

  it("sends the picked provider and its default mode with the created thread", async () => {
    const { invoke } = mockOperator();
    await openDraftComposer();

    await screen.findByRole("button", { name: "Choose model and provider" });
    await chooseProvider("Claude");
    const composer = screen.getByLabelText("Message new chat") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Use the picked provider" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ providerId: "claude", mode: "review", prompt: "Use the picked provider" }),
      );
    });
  });

  it("shows the thread provider as a semantic label and no mode picker in a live thread", async () => {
    mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });

    const composer = (await screen.findByLabelText("Message conversation")) as HTMLTextAreaElement;
    const provider = await screen.findByRole("button", { name: "Choose model and provider" });
    expect(provider.getAttribute("data-provider-instance")).toBe("codex_default");
    expect(provider.closest(".prompt-card")).not.toBeNull();
    fireEvent.click(provider);
    expect(screen.getByText("Provider Instance is locked after the first Turn.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Claude Code harness, Available" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    expect(screen.getByRole("button", { name: "Reasoning" })).toBeTruthy();
    expect(composer).toBeTruthy();
  });

  it("shows an unavailable stored provider truthfully instead of substituting another provider", async () => {
    mockOperator({ threadProviderId: "removed-provider" });
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });

    const provider = await screen.findByRole("button", { name: "Choose model and provider" });
    expect(provider.textContent).toBe("removed-provider (unavailable)");
    expect(provider.getAttribute("data-provider-instance")).toBe("");
    fireEvent.click(provider);
    expect((screen.getByRole("button", { name: "Codex harness, Available" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Claude Code harness, Available" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
