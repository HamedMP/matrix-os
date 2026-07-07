// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace, {
  clearComposerLaunchContext,
  mergeComposerSeed,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentWorkspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

function summaryFixture({
  threadCreate = false,
  threadTerminalSessionId,
  terminalSessionName = "matrix-abc1234",
}: { threadCreate?: boolean; threadTerminalSessionId?: string; terminalSessionName?: string } = {}) {
  return {
    runtime: {
      id: "rt_primary",
      label: "Primary",
      status: "available",
    },
    capabilities: [
      {
        id: "codingAgentsRuntimeSummary",
        enabled: true,
      },
      {
        id: "codingAgentsThreadCreate",
        enabled: threadCreate,
        ...(threadCreate ? {} : { reason: "Not enabled yet" }),
      },
      {
        id: "codingAgentsReview",
        enabled: true,
      },
    ],
    providers: [
      {
        id: "codex",
        kind: "codex",
        displayName: "Codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: {
      items: [],
      hasMore: false,
      limit: 20,
    },
    activeThreads: {
      items: [
        {
          id: "thread_alpha",
          providerId: "codex",
          title: "Fix settings route",
          status: "running",
          ...(threadTerminalSessionId ? { terminalSessionId: threadTerminalSessionId } : {}),
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    terminalSessions: {
      items: [
        {
          id: "matrix-abc1234",
          name: terminalSessionName,
          status: "running",
          attachable: true,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:02:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    recentActivity: {
      items: [],
      hasMore: false,
      limit: 20,
    },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
  };
}

function reviewsFixture() {
  return {
    items: [
      {
        id: "rev_desktop_1",
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
        status: "reviewing",
        pullRequestNumber: 758,
        round: 2,
        maxRounds: 3,
        reviewer: "matrix-reviewer",
        implementer: "matrix-implementer",
        findings: {
          total: 3,
          high: 1,
          medium: 1,
          low: 1,
        },
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
    ],
    hasMore: false,
    limit: 50,
  };
}

function reviewSnapshotFixture() {
  return {
    review: reviewsFixture().items[0],
    files: {
      items: [
        {
          path: "packages/gateway/src/coding-agents/routes.ts",
          status: "modified",
          additions: 12,
          deletions: 4,
          partial: true,
          hunks: [
            {
              id: "hunk_rev_desktop_1_0_0",
              oldStart: 42,
              oldLines: 3,
              newStart: 45,
              newLines: 5,
              heading: "Finding HIGH-1",
              partial: true,
            },
            {
              id: "hunk_rev_desktop_1_0_1",
              oldStart: 88,
              oldLines: 1,
              newStart: 93,
              newLines: 2,
              heading: "@@ -88 +93 @@",
              partial: false,
              lines: [
                {
                  kind: "context",
                  oldLine: 88,
                  newLine: 93,
                  content: "const request = parseReviewRequest(input);",
                },
                {
                  kind: "remove",
                  oldLine: 89,
                  content: "return rawReviewDetails;",
                },
                {
                  kind: "add",
                  newLine: 94,
                  content: "return safeReviewDetails;",
                },
              ],
            },
          ],
          findings: [
            {
              id: "HIGH-1",
              severity: "high",
              line: 42,
              summary: "Validate ownership before returning snapshots.",
            },
          ],
        },
      ],
      hasMore: false,
      limit: 100,
    },
    partial: true,
    safeNotice: "Diff content is not available yet. Showing bounded review findings.",
    updatedAt: "2026-07-06T00:02:00.000Z",
  };
}

function threadSnapshotFixture() {
  return {
    thread: {
      id: "thread_alpha",
      providerId: "codex",
      title: "Fix settings route",
      status: "waiting_for_approval",
      attention: "approval_required",
      terminalSessionId: "matrix-abc1234",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:04:00.000Z",
    },
    events: {
      items: [
        {
          type: "approval.requested",
          eventId: "evt_approval_desktop_1",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:03:00.000Z",
          approval: {
            approvalId: "appr_desktop_1",
            threadId: "thread_alpha",
            actionKind: "command",
            risk: "medium",
            title: "Run tests",
            safeDescription: "Run the focused desktop tests.",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_desktop_1",
          },
        },
      ],
      hasMore: false,
      limit: 200,
    },
  };
}

function approvalResolvedThreadSnapshotFixture() {
  return {
    ...threadSnapshotFixture(),
    thread: {
      ...threadSnapshotFixture().thread,
      status: "running",
      attention: "none",
      updatedAt: "2026-07-06T00:05:00.000Z",
    },
    events: {
      ...threadSnapshotFixture().events,
      items: [
        ...threadSnapshotFixture().events.items,
        {
          type: "approval.resolved",
          eventId: "evt_approval_desktop_2",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:05:00.000Z",
          approvalId: "appr_desktop_1",
          decision: "approve",
        },
      ],
    },
  };
}

function betaThreadSnapshotFixture() {
  return {
    thread: {
      id: "thread_beta",
      providerId: "codex",
      title: "Fix billing route",
      status: "running",
      attention: "none",
      createdAt: "2026-07-06T00:10:00.000Z",
      updatedAt: "2026-07-06T00:11:00.000Z",
    },
    events: {
      items: [],
      hasMore: false,
      limit: 200,
    },
  };
}

function multiApprovalThreadSnapshotFixture() {
  const base = threadSnapshotFixture();
  return {
    ...base,
    events: {
      ...base.events,
      items: [
        ...base.events.items,
        {
          type: "approval.requested",
          eventId: "evt_approval_desktop_2",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:04:00.000Z",
          approval: {
            approvalId: "appr_desktop_2",
            threadId: "thread_alpha",
            actionKind: "file_change",
            risk: "low",
            title: "Inspect diff",
            safeDescription: "Inspect the bounded diff.",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_desktop_2",
          },
        },
      ],
    },
  };
}

describe("AgentWorkspace", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({
      status: "idle",
      summary: null,
      error: null,
      reviewsStatus: "idle",
      reviews: null,
      reviewsError: null,
      selectedReviewId: null,
      reviewSnapshotStatus: "idle",
      reviewSnapshot: null,
      reviewSnapshotError: null,
      threadSnapshotStatus: "idle",
      threadSnapshot: null,
      threadSnapshotError: null,
      createStatus: "idle",
      createError: null,
      approvalActionStatus: "idle",
      pendingApprovalId: null,
      approvalActionError: null,
      pendingApprovalIds: [],
      approvalActionErrors: {},
      activeThreadId: null,
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
        if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
        if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
        if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
        return Promise.reject(new Error("unexpected channel"));
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders provider, thread, and terminal summaries from trusted IPC", async () => {
    render(<AgentWorkspace />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    await screen.findByText("Primary");
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Fix settings route")).toBeTruthy();
    expect(screen.getByText("matrix-abc1234")).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {});
  });

  it("marks the active coding-agent thread as current in the thread list", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    const activeThread = await screen.findByLabelText("Active thread Fix settings route");
    expect(activeThread.getAttribute("aria-current")).toBe("true");
  });

  it("hydrates selected thread details through trusted IPC", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Thread details")).toBeTruthy();
    expect(screen.getByText("waiting for approval")).toBeTruthy();
    expect(screen.getAllByText("matrix-abc1234").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Run the focused desktop tests.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-thread-snapshot", { threadId: "thread_alpha" });
  });

  it("submits approval decisions through trusted IPC and refreshes the thread details", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    const resolvedSnapshot = approvalResolvedThreadSnapshotFixture();
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:submit-approval-decision") return Promise.resolve(resolvedSnapshot);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const approve = await screen.findByRole("button", { name: /approve run tests/i });
    fireEvent.click(approve);

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:submit-approval-decision", {
        threadId: "thread_alpha",
        approvalId: "appr_desktop_1",
        decision: "approve",
        correlationId: "corr_desktop_1",
        clientRequestId: expect.stringMatching(/^req_desktop_/),
      });
    });
    expect(await screen.findByText("Approval resolved")).toBeTruthy();
    expect(screen.getByText("approve")).toBeTruthy();
  });

  it("does not reopen a stale approval thread after the user selects another thread", async () => {
    let resolveApproval: ((snapshot: ReturnType<typeof approvalResolvedThreadSnapshotFixture>) => void) | null = null;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:submit-approval-decision") {
        return new Promise((resolve) => {
          resolveApproval = resolve;
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_alpha",
      threadSnapshotStatus: "ready",
      threadSnapshot: threadSnapshotFixture(),
      summary: summaryFixture(),
    });

    const submit = useCodingAgentWorkspace.getState().submitApprovalDecision({
      threadId: "thread_alpha",
      approvalId: "appr_desktop_1",
      decision: "approve",
      correlationId: "corr_desktop_1",
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_beta",
      threadSnapshotStatus: "ready",
      threadSnapshot: betaThreadSnapshotFixture(),
    });
    resolveApproval?.(approvalResolvedThreadSnapshotFixture());
    await submit;

    expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_beta");
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_beta");
  });

  it("keeps independent approval rows actionable while another approval is pending", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    let resolveFirstApproval: ((snapshot: ReturnType<typeof approvalResolvedThreadSnapshotFixture>) => void) | null = null;
    window.operator.invoke = vi.fn((channel: string, payload?: { approvalId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(multiApprovalThreadSnapshotFixture());
      if (channel === "runtime:submit-approval-decision" && payload?.approvalId === "appr_desktop_1") {
        return new Promise((resolve) => {
          resolveFirstApproval = resolve;
        });
      }
      if (channel === "runtime:submit-approval-decision" && payload?.approvalId === "appr_desktop_2") {
        return Promise.resolve(multiApprovalThreadSnapshotFixture());
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const firstApprove = await screen.findByRole("button", { name: /approve run tests/i });
    const secondApprove = await screen.findByRole("button", { name: /approve inspect diff/i });
    fireEvent.click(firstApprove);
    await waitFor(() => expect((firstApprove as HTMLButtonElement).disabled).toBe(true));
    expect((secondApprove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(secondApprove);

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:submit-approval-decision", expect.objectContaining({
        approvalId: "appr_desktop_2",
      }));
    });
    await act(async () => {
      resolveFirstApproval?.(approvalResolvedThreadSnapshotFixture());
      await Promise.resolve();
    });
  });

  it("shows approval submission errors only on the failed approval row", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string, payload?: { approvalId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(multiApprovalThreadSnapshotFixture());
      if (channel === "runtime:submit-approval-decision" && payload?.approvalId === "appr_desktop_1") {
        return Promise.reject(new Error("provider leaked /home/matrix"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: /approve run tests/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Approval could not be sent. Try again.")).toHaveLength(1);
    });
  });

  it("clears selected thread details when the refreshed summary no longer includes the thread", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Thread details")).toBeTruthy();

    const refreshedSummary = {
      ...summaryFixture(),
      activeThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(refreshedSummary);
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(screen.queryByText("Thread details")).toBeNull();
    });
    expect(useCodingAgentWorkspace.getState().activeThreadId).toBeNull();
    expect(useCodingAgentWorkspace.getState().threadSnapshot).toBeNull();
    expect(screen.getByText("No active threads.")).toBeTruthy();
  });

  it("opens a bound thread terminal in the existing terminal tab model", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        return Promise.resolve(summaryFixture({ threadTerminalSessionId: "matrix-abc1234" }));
      }
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("Fix settings route");
    fireEvent.click(screen.getByRole("button", { name: "Open terminal for Fix settings route" }));

    const tabs = useTabs.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: "terminal",
      sessionName: "matrix-abc1234",
      title: "matrix-abc1234",
    });
    expect(useTabs.getState().activeTabId).toBe(tabs[0]?.id);
  });

  it("opens a bound thread terminal by canonical session id when the display name differs", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        return Promise.resolve(summaryFixture({
          threadTerminalSessionId: "matrix-abc1234",
          terminalSessionName: "friendly-shell",
        }));
      }
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("Fix settings route");
    fireEvent.click(screen.getByRole("button", { name: "Open terminal for Fix settings route" }));

    const tabs = useTabs.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: "terminal",
      sessionName: "matrix-abc1234",
      title: "friendly-shell",
    });
  });

  it("does not open stale thread terminal bindings", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        return Promise.resolve(summaryFixture({ threadTerminalSessionId: "matrix-missing" }));
      }
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("Fix settings route");
    expect(screen.queryByRole("button", { name: "Open terminal for Fix settings route" })).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  it("renders read-only review summaries through trusted IPC", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("Review");
    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByText(/PR #758/)).toBeTruthy();
    expect(screen.getByText("1 high")).toBeTruthy();
    expect(screen.getByText(/Round 2 of 3/)).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-reviews", {});
  });

  it("loads a read-only review snapshot when a review is selected", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-review-snapshot", {
      reviewId: "rev_desktop_1",
    });
    expect(await screen.findByText("packages/gateway/src/coding-agents/routes.ts")).toBeTruthy();
    expect(screen.getByText("Validate ownership before returning snapshots.")).toBeTruthy();
    expect(screen.getByText("Diff content is not available yet. Showing bounded review findings.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("renders selectable review hunk metadata without raw diff contents", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    expect(await screen.findByText("packages/gateway/src/coding-agents/routes.ts")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("-4")).toBeTruthy();
    expect(screen.getByText("@@ -42,3 +45,5 @@")).toBeTruthy();
    expect(screen.getByText("@@ -88,1 +93,2 @@")).toBeTruthy();
    expect(screen.getByText("Partial hunk")).toBeTruthy();

    const hunk = screen.getByRole("button", { name: /Select hunk 2 in packages\/gateway\/src\/coding-agents\/routes\.ts/i });
    fireEvent.click(hunk);
    expect(hunk.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/export const|function create|raw diff/i)).toBeNull();
  });

  it("renders gateway-bounded review diff lines with old and new line references", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    const contextLine = await screen.findByLabelText("Context line old 88 new 93");
    const removedLine = screen.getByLabelText("Removed line old 89");
    const addedLine = screen.getByLabelText("Added line new 94");

    expect(contextLine.textContent).toContain("88");
    expect(contextLine.textContent).toContain("93");
    expect(contextLine.textContent).toContain("const request = parseReviewRequest(input);");
    expect(removedLine.textContent).toContain("-");
    expect(removedLine.textContent).toContain("return rawReviewDetails;");
    expect(addedLine.textContent).toContain("+");
    expect(addedLine.textContent).toContain("return safeReviewDetails;");
    expect(addedLine.closest("button")).toBeNull();
  });

  it("seeds the desktop composer with structured review hunk follow-up context", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:create-thread") {
        return Promise.resolve({
          thread: {
            id: "thread_review_followup",
            providerId: "codex",
            title: "Follow up on review hunk",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    const hunk = await screen.findByRole("button", {
      name: /Select hunk 2 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));

    const prompt = screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement;
    expect(prompt.value).toContain("PR #758");
    expect(prompt.value).toContain("packages/gateway/src/coding-agents/routes.ts");
    expect(prompt.value).toContain("@@ -88,1 +93,2 @@");
    expect(prompt.value).not.toMatch(/export const|function create|raw diff/i);

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({
          prompt: expect.stringContaining("Please follow up on this review hunk"),
          attachments: [
            expect.objectContaining({
              kind: "structured_ref",
              label: expect.stringContaining("Review hunk"),
              path: "packages/gateway/src/coding-agents/routes.ts",
            }),
          ],
        }),
      );
    });
  });

  it("preserves existing desktop composer text when seeding review hunk follow-up context", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByLabelText("Agent run prompt");
    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Keep my existing investigation notes." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    const hunk = await screen.findByRole("button", {
      name: /Select hunk 1 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));

    const prompt = screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement;
    expect(prompt.value).toContain("Keep my existing investigation notes.");
    expect(prompt.value).toContain("Please follow up on this review hunk.");
  });

  it("leaves the desktop composer unchanged when a required follow-up reference cannot fit", () => {
    const currentAttachments = Array.from({ length: 8 }, (_, index) => ({
      id: `file_${index}`,
      kind: "file" as const,
      label: `Existing file ${index}`,
      path: `packages/example/${index}.ts`,
    }));

    const draft = mergeComposerSeed(
      {
        providerId: "codex",
        prompt: "Existing draft",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        attachments: currentAttachments,
      },
      {
        providerId: "codex",
        prompt: "Seeded review prompt",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        projectId: "matrix-os",
        attachments: [
          {
            id: "review:rev_desktop_1:hunk:hunk_2",
            kind: "structured_ref",
            label: "Review hunk 2",
            path: "packages/gateway/src/coding-agents/routes.ts",
          },
        ],
      },
    );

    expect(draft.attachments).toHaveLength(8);
    expect(draft.attachments?.map((attachment) => attachment.id)).toEqual(currentAttachments.map((attachment) => attachment.id));
    expect(draft.prompt).toBe("Existing draft");
    expect(draft.projectId).toBeUndefined();
  });

  it("preserves user attachments when clearing failed desktop follow-up launch context", () => {
    const cleaned = clearComposerLaunchContext({
      providerId: "codex",
      prompt: "Retry with my attached file.",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      projectId: "matrix-os",
      attachments: [
        {
          id: "file_existing_1",
          kind: "file",
          label: "Existing file",
          path: "packages/example/existing.ts",
        },
        {
          id: "review:rev_desktop_1:hunk:hunk_2",
          kind: "structured_ref",
          label: "Review hunk 2",
          path: "packages/gateway/src/coding-agents/routes.ts",
        },
      ],
    });

    expect(cleaned.projectId).toBeUndefined();
    expect(cleaned.attachments).toEqual([
      expect.objectContaining({
        id: "file_existing_1",
        kind: "file",
      }),
    ]);
  });

  it("clears seeded review project context after a desktop follow-up run starts", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:create-thread") {
        return Promise.resolve({
          thread: {
            id: "thread_review_followup",
            providerId: "codex",
            title: "Follow up on review hunk",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    const hunk = await screen.findByRole("button", {
      name: /Select hunk 1 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({ projectId: "matrix-os" }),
      );
    });

    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Start an unrelated desktop run." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      const createCalls = vi.mocked(window.operator.invoke).mock.calls
        .filter(([channel]) => channel === "runtime:create-thread");
      expect(createCalls).toHaveLength(2);
      expect(createCalls[1]?.[1]).toEqual(expect.not.objectContaining({ projectId: "matrix-os" }));
    });
  });

  it("clears seeded review project context after a desktop follow-up start fails", async () => {
    let createCount = 0;
    let rejectFirstCreate: (reason?: unknown) => void = () => undefined;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:create-thread") {
        createCount += 1;
        if (createCount === 1) {
          return new Promise((_, reject) => {
            rejectFirstCreate = reject;
          });
        }
        return Promise.resolve({
          thread: {
            id: "thread_unrelated_after_failure",
            providerId: "codex",
            title: "Unrelated desktop run",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    const hunk = await screen.findByRole("button", {
      name: /Select hunk 1 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Start an unrelated desktop run after a failed follow-up." },
    });
    rejectFirstCreate(new Error("provider failed at /home/matrix/private token secret"));

    expect(await screen.findByText("Agent run could not be started. Try again.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      const createCalls = vi.mocked(window.operator.invoke).mock.calls
        .filter(([channel]) => channel === "runtime:create-thread");
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]?.[1]).toEqual(expect.objectContaining({
        projectId: "matrix-os",
        attachments: [expect.objectContaining({ kind: "structured_ref" })],
      }));
      expect(createCalls[1]?.[1]).toEqual(expect.not.objectContaining({ projectId: "matrix-os" }));
      expect(createCalls[1]?.[1]).toEqual(expect.not.objectContaining({ attachments: expect.anything() }));
    });
  });

  it("keeps a seeded desktop follow-up draft across runtime summary refreshes", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    const hunk = await screen.findByRole("button", {
      name: /Select hunk 2 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));

    const prompt = screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement;
    expect(prompt.value).toContain("PR #758");

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement).value).toContain("PR #758");
    });
    expect((screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement).value).toContain("@@ -88,1 +93,2 @@");
  });

  it("uses refreshed review hunk data when reseeding desktop follow-up context", async () => {
    const refreshedSnapshot = {
      ...reviewSnapshotFixture(),
      files: {
        ...reviewSnapshotFixture().files,
        items: reviewSnapshotFixture().files.items.map((file) => ({
          ...file,
          hunks: file.hunks.map((hunk, hunkIndex) => hunkIndex === 1
            ? {
                ...hunk,
                oldStart: 120,
                oldLines: 4,
                newStart: 130,
                newLines: 6,
              }
            : hunk),
        })),
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") {
        const calls = vi.mocked(window.operator.invoke).mock.calls
          .filter(([candidate]) => candidate === "runtime:get-review-snapshot");
        return Promise.resolve(calls.length === 1 ? reviewSnapshotFixture() : refreshedSnapshot);
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    const reviewButton = screen.getByRole("button", { name: /Open review PR #758/i });
    fireEvent.click(reviewButton);
    const hunk = await screen.findByRole("button", {
      name: /Select hunk 2 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunk);
    fireEvent.click(reviewButton);
    expect(await screen.findByText("@@ -120,4 +130,6 @@")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ask agent about selected hunk" }));

    const prompt = screen.getByLabelText("Agent run prompt") as HTMLTextAreaElement;
    expect(prompt.value).toContain("@@ -120,4 +130,6 @@");
    expect(prompt.value).not.toContain("@@ -88,1 +93,2 @@");
  });

  it("keeps hunk selection scoped to the file when hunk ids collide", async () => {
    const collisionSnapshot = {
      ...reviewSnapshotFixture(),
      files: {
        ...reviewSnapshotFixture().files,
        items: [
          {
            ...reviewSnapshotFixture().files.items[0],
            path: "packages/alpha/src/review-target.ts",
            hunks: [
              {
                ...reviewSnapshotFixture().files.items[0]!.hunks[0],
                id: "hunk_collision_0",
              },
            ],
          },
          {
            ...reviewSnapshotFixture().files.items[0],
            path: "packages/beta/src/review-target.ts",
            hunks: [
              {
                ...reviewSnapshotFixture().files.items[0]!.hunks[0],
                id: "hunk_collision_0",
              },
            ],
            findings: [],
          },
        ],
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(collisionSnapshot);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    const firstHunk = await screen.findByRole("button", { name: /Select hunk 1 in packages\/alpha\/src\/review-target\.ts/i });
    const secondHunk = screen.getByRole("button", { name: /Select hunk 1 in packages\/beta\/src\/review-target\.ts/i });
    fireEvent.click(secondHunk);

    expect(firstHunk.getAttribute("aria-pressed")).toBe("false");
    expect(secondHunk.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps hunk selection scoped to duplicate rendered file rows", async () => {
    const collisionSnapshot = {
      ...reviewSnapshotFixture(),
      files: {
        ...reviewSnapshotFixture().files,
        items: [
          {
            ...reviewSnapshotFixture().files.items[0],
            hunks: [
              {
                ...reviewSnapshotFixture().files.items[0]!.hunks[0],
                id: "hunk_collision_0",
              },
            ],
          },
          {
            ...reviewSnapshotFixture().files.items[0],
            hunks: [
              {
                ...reviewSnapshotFixture().files.items[0]!.hunks[0],
                id: "hunk_collision_0",
              },
            ],
            findings: [],
          },
        ],
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(collisionSnapshot);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));

    const hunkButtons = await screen.findAllByRole("button", {
      name: /Select hunk 1 in packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    });
    fireEvent.click(hunkButtons[1]!);

    expect(hunkButtons[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(hunkButtons[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a generic safe review error without dropping the runtime summary", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") {
        return Promise.reject(new Error("review store failed at /home/matrix/private token secret"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("Primary");
    expect(await screen.findByText("Review state unavailable")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("clears loaded review details when review summaries become unavailable", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    expect(await screen.findByText("Validate ownership before returning snapshots.")).toBeTruthy();

    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") {
        return Promise.reject(new Error("review store failed at /home/matrix/private token secret"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    expect(await screen.findByText("Review state unavailable")).toBeTruthy();
    expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("clears loaded review details when runtime summary refresh fails", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    expect(await screen.findByText("Validate ownership before returning snapshots.")).toBeTruthy();

    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        return Promise.reject(new Error("summary failed at /home/matrix/private token secret"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    });
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("does not restore an in-flight review snapshot after refresh removes the review", async () => {
    let resolveSnapshot: (value: unknown) => void = () => undefined;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") {
        return new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });
    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    expect(await screen.findByText("Loading review details...")).toBeTruthy();

    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve({ items: [], hasMore: false, limit: 50 });
      return Promise.reject(new Error("unexpected channel"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));
    await screen.findByText("No reviews.");

    resolveSnapshot(reviewSnapshotFixture());

    await waitFor(() => {
      expect(screen.queryByText("Validate ownership before returning snapshots.")).toBeNull();
    });
    expect(screen.queryByText("packages/gateway/src/coding-agents/routes.ts")).toBeNull();
  });

  it("creates a thread from the desktop composer and focuses the new thread", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:create-thread") {
        return Promise.resolve({
          thread: {
            id: "thread_desktop_1",
            providerId: "codex",
            title: "Investigate flaky desktop check",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByLabelText("Agent run prompt");
    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Investigate flaky desktop check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith(
        "runtime:create-thread",
        expect.objectContaining({
          providerId: "codex",
          prompt: "Investigate flaky desktop check",
          clientRequestId: expect.stringMatching(/^req_desktop_/),
        }),
      );
    });
    expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_desktop_1");
  });

  it("shows safe composer validation and create failures", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:create-thread") {
        return Promise.reject(new Error("provider failed on /home/matrix/private with token secret"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByLabelText("Agent run prompt");
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByText("Enter a prompt before starting an agent run.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Investigate flaky desktop check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Agent run could not be started. Try again.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("does not submit duplicate create requests while one is in flight", async () => {
    let resolveCreate: (value: unknown) => void = () => undefined;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:create-thread") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({ summary: summaryFixture({ threadCreate: true }) });
    const draft = {
      providerId: "codex",
      prompt: "Investigate duplicate submits",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    } as const;

    const first = useCodingAgentWorkspace.getState().createThread(draft);
    const second = useCodingAgentWorkspace.getState().createThread(draft);

    await expect(second).resolves.toBeNull();
    expect(window.operator.invoke).toHaveBeenCalledTimes(1);
    resolveCreate({
      thread: {
        id: "thread_duplicate_1",
        providerId: "codex",
        title: "Investigate duplicate submits",
        status: "queued",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      events: {
        items: [],
        hasMore: false,
        limit: 200,
      },
    });
    await expect(first).resolves.toBe("thread_duplicate_1");
  });

  it("shows a generic safe error when summary refresh fails", async () => {
    window.operator.invoke = vi.fn().mockRejectedValue(
      new Error("connect ECONNREFUSED /home/matrix/private"),
    );

    render(<AgentWorkspace />);

    await screen.findByText("Runtime summary unavailable");
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
  });
});
