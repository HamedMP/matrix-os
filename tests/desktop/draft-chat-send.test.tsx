// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProjectAgentWorkspace,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import ProjectChatsView from "../../desktop/src/renderer/src/features/project/ProjectChatsView";
import { useProviderPreferences } from "../../desktop/src/renderer/src/features/settings/provider-preferences";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useInspectorLayout } from "../../desktop/src/renderer/src/features/panels/inspector-layout-store";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { clearDraftChats, useDraftChat } from "../../desktop/src/renderer/src/stores/draft-chat";
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const NOW = "2026-07-12T12:00:00.000Z";
const defaultResolveNewChatTarget = useProjectWorkspaces.getState().resolveNewChatTarget;

function summaryFixture(providers: RuntimeSummary["providers"] = [{
  id: "codex",
  kind: "codex",
  displayName: "Codex",
  availability: "available",
  installStatus: "installed",
  authStatus: "authenticated",
  supportedModes: ["default", "plan"],
  defaultMode: "default",
  setupActions: [],
}]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsThreadCreate", enabled: true },
      { id: "codingAgentsSameThreadTurns", enabled: true },
      { id: "codingAgentsReview", enabled: true },
      { id: "codingAgentsProjectWorkspace", enabled: true },
    ],
    providers,
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

function mockOperator({ createImpl, summary = summaryFixture() }: {
  createImpl?: (payload: unknown) => Promise<unknown>;
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
  clearDraftChats();
  useProjectView.setState({ entries: {}, runtimeScope: null });
  useProjectWorkspaces.setState({ entries: {}, resolveNewChatTarget: defaultResolveNewChatTarget });
  useProjectChatLauncher.setState({ composerRequest: null });
  useTabs.setState(useTabs.getInitialState(), true);
  useInspectorLayout.setState({ entries: {}, runtimeScope: null });
  useProviderPreferences.setState({ defaultProviderId: null, composerSelections: {}, hydrated: false });
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
  return await screen.findByLabelText("Message new chat");
}

async function setComposerText(composer: HTMLElement, value: string) {
  for (const key of value) {
    fireEvent.keyDown(window, { key });
  }
  await waitFor(() => expect(composer.textContent).toBe(value));
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

    await setComposerText(composer, "Investigate the flaky desktop check");
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
    expect(useDraftChat.getState().draftFor("matrix-os")).toBeNull();
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

    await setComposerText(composer, "Summarize the release notes");
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

  it("sends Project Chat resource tokens as explicit agent context", async () => {
    const { invoke } = mockOperator();
    const composer = await openDraft();
    await setComposerText(composer, "Inspect @Matrix");

    fireEvent.click(await screen.findByRole("option", { name: /Matrix OS/ }));

    expect(await screen.findByTestId("composer-reference-token-project-matrix-os")).toBeTruthy();
    await waitFor(() => expect(composer.textContent).toBe("Inspect Matrix OS "));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "runtime:create-thread",
      expect.objectContaining({
        prompt: "Inspect [Matrix OS](matrix-os)",
      }),
    ));
  });

  it.each([
    {
      name: "no provider",
      providers: [],
      availability: "Unavailable",
    },
    {
      name: "missing provider install",
      providers: [{
        ...summaryFixture().providers[0]!,
        availability: "setup_required" as const,
        installStatus: "missing" as const,
        authStatus: "missing" as const,
        setupActions: [{
          id: "codex_install",
          kind: "foreground_terminal" as const,
          label: "Install Codex",
          command: "npm install -g @openai/codex",
        }],
      }],
      availability: "Setup required",
      action: "Install Codex",
    },
    {
      name: "provider authentication required",
      providers: [{
        ...summaryFixture().providers[0]!,
        availability: "auth_required" as const,
        authStatus: "missing" as const,
        setupActions: [{
          id: "codex_connect",
          kind: "foreground_terminal" as const,
          label: "Connect Codex",
          command: "codex login",
        }],
      }],
      availability: "Authentication required",
      action: "Connect Codex",
    },
    {
      name: "expired provider authentication",
      providers: [{
        ...summaryFixture().providers[0]!,
        availability: "auth_required" as const,
        authStatus: "expired" as const,
        setupActions: [{
          id: "codex_reconnect",
          kind: "foreground_terminal" as const,
          label: "Reconnect Codex",
          command: "codex login",
        }],
      }],
      availability: "Authentication required",
      action: "Reconnect Codex",
    },
    {
      name: "provider install in progress",
      providers: [{
        ...summaryFixture().providers[0]!,
        availability: "installing" as const,
        installStatus: "installing" as const,
        authStatus: "unknown" as const,
      }],
      availability: "Setup required",
    },
    {
      name: "unverified provider",
      providers: [{
        ...summaryFixture().providers[0]!,
        availability: "unknown" as const,
        installStatus: "unknown" as const,
        authStatus: "unknown" as const,
      }],
      availability: "Unavailable",
    },
  ])("blocks $name in the canonical picker without losing the editable draft", async ({ name, providers, availability, action }) => {
    const { invoke } = mockOperator({ summary: summaryFixture(providers) });
    const composer = await openDraft();
    const prompt = `Preserve this ${name}`;

    await setComposerText(composer, prompt);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(composer, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const harness = screen.getByRole("button", { name: `Codex harness, ${availability}` });
    expect(harness.className).toContain("opacity-35");
    if (action) {
      fireEvent.click(harness);
      expect(screen.getByRole("button", { name: action })).toBeTruthy();
    }
    expect(composer.getAttribute("contenteditable")).toBe("true");
    expect(composer.textContent).toBe(prompt);
    expect(useDraftChat.getState().draftFor("matrix-os")?.prompt).toBe(prompt);
    expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "runtime:create-thread")).toHaveLength(0);
  });

  it("resolves the project relation lazily when the draft was typed without a seed", async () => {
    const { invoke } = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    // Deselect without going through the + button: no seed, no relation.
    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });
    const composer = await screen.findByLabelText("Message new chat");

    await setComposerText(composer, "Direct draft with no seed");
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ prompt: "Direct draft with no seed", projectId: "matrix-os" }),
      );
    });
  });

  it("locks the composer while a lazy project relation is resolving", async () => {
    let resolveTarget!: (value: { projectId: string }) => void;
    const resolveNewChatTarget = vi.fn(() => new Promise<{ projectId: string }>((resolve) => {
      resolveTarget = resolve;
    }));
    useProjectWorkspaces.setState({ resolveNewChatTarget });
    const { invoke } = mockOperator();
    render(<ProjectChatsView projectId="matrix-os" active />);
    await screen.findByRole("region", { name: "Conversation Plan the auth work" });
    act(() => {
      useProjectView.getState().setSelectedThread("matrix-os", null);
    });
    const composer = await screen.findByLabelText("Message new chat");

    await setComposerText(composer, "Keep the complete prompt");
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      expect(resolveNewChatTarget).toHaveBeenCalledWith("matrix-os");
    });
    expect(composer.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "runtime:create-thread")).toHaveLength(0);

    await act(async () => {
      resolveTarget({ projectId: "matrix-os" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ prompt: "Keep the complete prompt", projectId: "matrix-os" }),
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

    await setComposerText(composer, "Wait for me");
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

    await setComposerText(composer, "Keep this draft text");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Agent run could not be started. Try again.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
    // The draft survives the failure so the user can retry.
    expect(composer.textContent).toBe("Keep this draft text");
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
  });

  it("keeps downward Project Chat composer menus outside the draft clipping boundary", async () => {
    mockOperator();
    await openDraft();

    const pane = screen.getByRole("region", { name: "New chat in Matrix OS" });
    expect(pane.className).toContain("overflow-visible");
    expect(pane.className).not.toContain("overflow-hidden");
  });

  it("uploads dropped files and creates a project chat with typed file attachments", async () => {
    const putBytes = vi.fn(async (path: string, file: File) => ({
      ok: true,
      path: decodeURIComponent(path.split("path=")[1] ?? ""),
      size: file.size,
    }));
    useConnection.setState({ api: { putBytes } as never });
    const { invoke } = mockOperator();
    const composer = await openDraft();
    const pane = screen.getByRole("region", { name: "New chat in Matrix OS" });
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(["context"], "context.txt", { type: "text/plain" })] },
    });

    expect(await screen.findByRole("button", { name: "Remove context.txt" })).toBeTruthy();
    await setComposerText(composer, "Use this context");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({
          prompt: "Use this context",
          attachments: [expect.objectContaining({
            id: expect.stringMatching(/^desktop_upload_[A-Za-z0-9]+$/),
            kind: "file",
            label: "context.txt",
            path: expect.stringMatching(/^temporary\/desktop-chat\/[A-Za-z0-9]+-context\.txt$/),
            mimeType: "text/plain",
          })],
        }),
      );
    });
    expect(screen.queryByRole("button", { name: "Remove context.txt" })).toBeNull();
  });
});
