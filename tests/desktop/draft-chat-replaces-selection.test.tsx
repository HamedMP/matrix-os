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
import { useProjectChatLauncher } from "../../desktop/src/renderer/src/lib/project-chat";
import { clearDraftChats, useDraftChat } from "../../desktop/src/renderer/src/stores/draft-chat";
import { codingAgentRuntimeScope } from "../../desktop/src/shared/coding-agent-project-workspace";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

const NOW = "2026-07-12T12:00:00.000Z";
const RUNTIME_SCOPE = codingAgentRuntimeScope({
  handle: "operator",
  platformHost: "https://platform.test",
  runtimeSlot: "primary",
});
const defaultResolveNewChatTarget = useProjectWorkspaces.getState().resolveNewChatTarget;

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
        displayName: "Claude Code",
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
      items: [
        {
          id: "thread_plan",
          providerId: "codex",
          title: "Plan the auth work",
          status: "running",
          attention: "none",
          projectId: "matrix-os",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "thread_newer",
          providerId: "codex",
          title: "Investigate the callback",
          status: "queued",
          attention: "none",
          projectId: "matrix-os",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      hasMore: false,
      limit: 100,
    },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: NOW,
  };
}

function reviewsFixture() {
  return {
    items: [{
      id: "rev_desktop_1",
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      status: "reviewing",
      pullRequestNumber: 758,
      round: 2,
      maxRounds: 3,
      reviewer: "matrix-reviewer",
      implementer: "matrix-implementer",
      findings: { total: 3, high: 1, medium: 1, low: 1 },
      updatedAt: "2026-07-06T00:02:00.000Z",
    }],
    hasMore: false,
    limit: 50,
  };
}

function reviewSnapshotFixture() {
  return {
    review: reviewsFixture().items[0],
    files: {
      items: [{
        path: "packages/gateway/src/coding-agents/routes.ts",
        status: "modified",
        additions: 12,
        deletions: 4,
        partial: true,
        hunks: [{
          id: "hunk_rev_desktop_1_0_1",
          oldStart: 88,
          oldLines: 1,
          newStart: 93,
          newLines: 2,
          heading: "@@ -88 +93 @@",
          partial: false,
          lines: [
            { kind: "context", oldLine: 88, newLine: 93, content: "const request = parseReviewRequest(input);" },
            { kind: "remove", oldLine: 89, content: "return rawReviewDetails;" },
            { kind: "add", newLine: 94, content: "return safeReviewDetails;" },
          ],
        }],
        findings: [],
      }],
      hasMore: false,
      limit: 100,
    },
    partial: false,
    safeNotice: null,
    updatedAt: "2026-07-06T00:02:00.000Z",
  };
}

function mockOperator() {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === "runtime:get-summary") return summaryFixture();
    if (channel === "runtime:get-reviews") return reviewsFixture();
    if (channel === "runtime:get-review-snapshot") return reviewSnapshotFixture();
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
  // Most of this suite covers draft replacement; keep the inspector expanded
  // for the one review-follow-up case that intentionally enters that surface.
  useInspectorLayout.setState({
    entries: {
      "matrix-os": { widthPct: 34, collapsed: false, maximized: false },
    },
    runtimeScope: RUNTIME_SCOPE,
    hydratedScope: RUNTIME_SCOPE,
  });
  resetProviderPreferences();
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

async function renderWithSelectedThread() {
  render(<ProjectChatsView projectId="matrix-os" active />);
  // The first listed chat auto-selects, so the conversation is visible.
  await screen.findByRole("region", { name: "Conversation Plan the auth work" });
  await waitFor(() => {
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_plan");
  });
}

describe("draft chat replaces the selected thread", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("deselects the current thread and shows the draft composer when the rail + is clicked", async () => {
    mockOperator();
    await renderWithSelectedThread();
    const listedChatsBefore = screen.getAllByRole("button", { name: /^Chat / }).map((row) => row.textContent);

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));

    // The draft state replaces the conversation in place, Codex-style.
    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    expect(screen.getByLabelText("Message new chat")).toBeTruthy();
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    // The form-based composer is gone from the Chats view entirely.
    expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
    expect(screen.queryByLabelText("Agent run prompt")).toBeNull();
    // No rail row keeps the current-page marker while drafting.
    expect(screen.getByRole("button", { name: "Chat Plan the auth work" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Chat / }).map((row) => row.textContent))
      .toEqual(listedChatsBefore);
    expect(screen.queryByRole("button", { name: /Chat New (chat|conversation)/i })).toBeNull();
  });

  it("deselects the current thread and focuses the draft composer for a compose request (⌘J)", async () => {
    mockOperator();
    await renderWithSelectedThread();

    act(() => {
      useProjectChatLauncher.getState().requestComposer("matrix-os");
    });

    const composer = await screen.findByLabelText("Message new chat");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("deselects the current thread and seeds the draft when typing starts", async () => {
    mockOperator();
    await renderWithSelectedThread();
    await act(async () => {});

    fireEvent.keyDown(window, { key: "h" });

    const composer = await screen.findByLabelText("Message new chat");
    await waitFor(() => expect(composer.textContent).toBe("h"));
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("appends typed characters to the existing draft instead of seeding a second prompt", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    const composer = await screen.findByLabelText("Message new chat");

    await setSharedComposerText(composer, "hello");
    // Focus left the composer (e.g. the user clicked the transcript area).
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.keyDown(window, { key: "!" });

    await waitFor(() => expect(composer.textContent).toBe("hello!"));
    expect(composer.textContent).not.toContain("---");
  });

  it("seeds the draft prompt when a suggestion chip is clicked", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await screen.findByText("What should we work on?");

    fireEvent.click(screen.getByRole("button", { name: "Review code and suggest changes" }));

    const composer = await screen.findByLabelText("Message new chat");
    await waitFor(() => expect(composer.textContent).toBe("Review code and suggest changes"));
    // Exactly one composer exists — the draft pane never duplicates the form.
    expect(screen.getAllByLabelText("Message new chat")).toHaveLength(1);
    expect(screen.queryByLabelText("Agent run prompt")).toBeNull();
  });

  it("shows the conversation again when a rail thread is selected from the draft state", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await screen.findByText("What should we work on?");

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));

    expect(await screen.findByRole("region", { name: "Conversation Plan the auth work" })).toBeTruthy();
    expect(screen.queryByLabelText("Message new chat")).toBeNull();
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_plan");
  });

  it("preserves an unsent draft across thread selection and back", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    const composer = await screen.findByLabelText("Message new chat");
    await setSharedComposerText(composer, "half-written thought");
    await waitFor(() => expect(composer.textContent).toBe("half-written thought"));

    // Selecting a thread unmounts the draft pane (inspector access); the
    // composed input must survive the round trip.
    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));
    expect(await screen.findByRole("region", { name: "Conversation Plan the auth work" })).toBeTruthy();
    expect(screen.queryByLabelText("Message new chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    const restored = await screen.findByLabelText("Message new chat");
    await waitFor(() => expect(restored.textContent).toBe("half-written thought"));
  });

  it("preserves a provider-only draft across thread selection and back", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await screen.findByLabelText("Message new chat");

    const provider = await screen.findByRole("button", { name: "Choose model and provider" });
    fireEvent.click(provider);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code harness, Available" }));
    fireEvent.click(screen.getByRole("option", { name: /Claude Code · Available/ }));
    await waitFor(() => expect(provider.getAttribute("data-provider-instance")).toBe("claude_code_default"));
    await waitFor(() => expect(useDraftChat.getState().draftFor("matrix-os")?.providerId).toBe("claude"));
    expect(screen.getByLabelText("Message new chat").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));
    expect(await screen.findByRole("region", { name: "Conversation Plan the auth work" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await screen.findByLabelText("Message new chat");
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose model and provider" }).getAttribute("data-provider-instance")).toBe("claude_code_default"));
    expect(screen.getByLabelText("Message new chat").textContent).toBe("");
  });

  it("preserves a permission-only draft across thread selection and back", async () => {
    mockOperator();
    await renderWithSelectedThread();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await screen.findByLabelText("Message new chat");

    const permission = await screen.findByRole("button", { name: "Permission mode" });
    fireEvent.click(permission);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "full access" }));
    await waitFor(() => expect(permission.textContent).toContain("full access"));
    await waitFor(() => expect(useDraftChat.getState().draftFor("matrix-os")?.sandboxMode).toBe("full_access"));
    expect(screen.getByLabelText("Message new chat").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Chat Plan the auth work" }));
    expect(await screen.findByRole("region", { name: "Conversation Plan the auth work" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("full access"));
    expect(screen.getByLabelText("Message new chat").textContent).toBe("");
  });

  it("does not clear a newer thread selection when project targeting resolves late", async () => {
    let resolveTarget!: (value: { projectId: string }) => void;
    useProjectWorkspaces.setState({
      resolveNewChatTarget: vi.fn(() => new Promise<{ projectId: string }>((resolve) => {
        resolveTarget = resolve;
      })),
    });
    mockOperator();
    await renderWithSelectedThread();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Matrix OS" }));
    await waitFor(() => {
      expect(useProjectWorkspaces.getState().resolveNewChatTarget).toHaveBeenCalledWith("matrix-os", undefined);
    });

    fireEvent.click(screen.getByRole("button", { name: "Chat Investigate the callback" }));
    await act(async () => {
      resolveTarget({ projectId: "matrix-os" });
      await Promise.resolve();
    });

    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBe("thread_newer");
    expect(screen.queryByLabelText("Message new chat")).toBeNull();
  });

  it("routes a review-hunk follow-up into the draft state with the seeded prompt", async () => {
    mockOperator();
    await renderWithSelectedThread();

    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    const hunk = await screen.findByRole("button", {
      name: /Select hunk 1 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));

    // The seeded follow-up lands in the draft composer, replacing the
    // selected thread — not in a separate inspector form.
    expect(await screen.findByText("What should we work on?")).toBeTruthy();
    const composer = await screen.findByLabelText("Message new chat");
    await waitFor(() => {
      expect(composer.textContent).toContain("Please follow up on this review hunk.");
      expect(composer.textContent).toContain("PR #758");
    });
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
    expect(screen.queryByLabelText("Agent run prompt")).toBeNull();
  });
});
