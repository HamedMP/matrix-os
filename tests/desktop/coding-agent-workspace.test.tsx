// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace, {
  clearComposerLaunchContext,
  mergeComposerSeed,
} from "../../desktop/src/renderer/src/features/coding-agents/AgentWorkspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";
import { reconcileDesktopRuntimeChange } from "../../desktop/src/renderer/src/stores/runtime-transition";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

async function selectInspectorTab(name: "Changes" | "Terminal" | "Preview" | "Activity") {
  fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}\\b`) }));
}

function summaryFixture({
  threadCreate = false,
  sameThreadTurns = true,
  files = false,
  sourceControl = false,
  threadTerminalSessionId,
  terminalSessionName = "matrix-abc1234",
}: { threadCreate?: boolean; sameThreadTurns?: boolean; files?: boolean; sourceControl?: boolean; threadTerminalSessionId?: string; terminalSessionName?: string } = {}) {
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
        id: "codingAgentsSameThreadTurns",
        enabled: sameThreadTurns,
        ...(sameThreadTurns ? {} : { reason: "Not enabled yet" }),
      },
      {
        id: "codingAgentsReview",
        enabled: true,
      },
      ...(files
        ? [{
            id: "codingAgentsFiles",
            enabled: true,
          }]
        : []),
      ...(sourceControl
        ? [{
            id: "codingAgentsSourceControl",
            enabled: true,
          }]
        : []),
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
    attentionThreads: {
      items: [],
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

function attentionOnlySummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [],
    },
    attentionThreads: {
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_approval",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_failed",
          title: "Repair failed run",
          status: "failed",
          attention: "failed",
        },
      ],
      hasMore: false,
      limit: 20,
    },
  };
}

function previewSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    capabilities: [
      ...summary.capabilities,
      {
        id: "codingAgentsPreview",
        enabled: true,
      },
    ],
    previewSessions: {
      items: [
        {
          id: "prev_local",
          label: "Local web app",
          status: "running",
          origin: "http://localhost:3000",
          updatedAt: "2026-07-06T00:04:00.000Z",
        },
        {
          id: "prev_internal",
          label: "Internal service",
          status: "running",
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
        {
          id: "prev_secure",
          label: "Secure app",
          status: "running",
          origin: "https://preview.matrix-os.test",
          updatedAt: "2026-07-06T00:05:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function fileReadFixture() {
  return {
    metadata: {
      path: "packages/gateway/src/coding-agents/routes.ts",
      kind: "file",
      sizeBytes: 37,
      etag: "sha256_desktop_file",
      updatedAt: "2026-07-06T00:03:00.000Z",
    },
    content: "export const safeRoute = true;\n",
    encoding: "utf8",
    truncated: false,
    limitBytes: 65536,
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

function reviewReadyThreadSnapshotFixture() {
  const base = threadSnapshotFixture();
  return {
    ...base,
    thread: {
      ...base.thread,
      status: "running",
      attention: "none",
    },
    events: {
      ...base.events,
      items: [
        ...base.events.items,
        {
          type: "review.ready",
          eventId: "evt_review_desktop_1",
          threadId: "thread_alpha",
          reviewId: "rev_desktop_1",
          summary: {
            changedFileCount: 2,
            additions: 12,
            deletions: 4,
            partial: true,
          },
          occurredAt: "2026-07-06T00:04:00.000Z",
        },
      ],
    },
  };
}

function attentionThreadSnapshotFixture() {
  return {
    ...threadSnapshotFixture(),
    thread: {
      ...threadSnapshotFixture().thread,
      id: "thread_failed",
      title: "Repair failed run",
      status: "failed",
      attention: "failed",
      terminalSessionId: undefined,
      updatedAt: "2026-07-06T00:06:00.000Z",
    },
    events: {
      items: [],
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

function resolvedAttentionApprovalSnapshotFixture() {
  const resolved = approvalResolvedThreadSnapshotFixture();
  return {
    ...resolved,
    thread: {
      ...resolved.thread,
      id: "thread_approval",
      title: "Approve deployment",
      status: "running",
      attention: "none",
      terminalSessionId: undefined,
      updatedAt: "2026-07-06T00:07:00.000Z",
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

function betaApprovalSameIdThreadSnapshotFixture() {
  return {
    thread: {
      ...betaThreadSnapshotFixture().thread,
      status: "waiting_for_approval",
      attention: "approval_required",
    },
    events: {
      items: [
        {
          type: "approval.requested",
          eventId: "evt_approval_beta_1",
          threadId: "thread_beta",
          occurredAt: "2026-07-06T00:12:00.000Z",
          approval: {
            approvalId: "appr_desktop_1",
            threadId: "thread_beta",
            actionKind: "command",
            risk: "low",
            title: "Run beta tests",
            safeDescription: "Run the beta desktop tests.",
            allowedDecisions: ["approve", "decline"],
            correlationId: "corr_desktop_beta_1",
          },
        },
      ],
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

function inputRequestedThreadSnapshotFixture() {
  return {
    thread: {
      id: "thread_alpha",
      providerId: "codex",
      title: "Fix settings route",
      status: "waiting_for_input",
      attention: "input_required",
      terminalSessionId: "matrix-abc1234",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:06:00.000Z",
    },
    events: {
      items: [
        {
          type: "user_input.requested",
          eventId: "evt_input_desktop_1",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:06:00.000Z",
          request: {
            requestId: "req_input_desktop_1",
            threadId: "thread_alpha",
            title: "Clarify failure",
            safeDescription: "Which desktop test should run next?",
            placeholder: "Describe the focused test",
            required: true,
            correlationId: "corr_input_desktop_1",
          },
        },
      ],
      hasMore: false,
      limit: 200,
    },
  };
}

function inputAnsweredThreadSnapshotFixture() {
  return {
    ...inputRequestedThreadSnapshotFixture(),
    thread: {
      ...inputRequestedThreadSnapshotFixture().thread,
      status: "running",
      attention: "none",
      updatedAt: "2026-07-06T00:07:00.000Z",
    },
    events: {
      ...inputRequestedThreadSnapshotFixture().events,
      items: [
        ...inputRequestedThreadSnapshotFixture().events.items,
        {
          type: "user_input.answered",
          eventId: "evt_input_desktop_2",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:07:00.000Z",
          requestId: "req_input_desktop_1",
          correlationId: "corr_input_desktop_1",
        },
      ],
    },
  };
}

function resolvedAttentionInputSnapshotFixture() {
  const answered = inputAnsweredThreadSnapshotFixture();
  return {
    ...answered,
    thread: {
      ...answered.thread,
      id: "thread_approval",
      title: "Approve deployment",
      status: "running",
      attention: "none",
      terminalSessionId: undefined,
      updatedAt: "2026-07-06T00:08:00.000Z",
    },
  };
}

function multiInputRequestedThreadSnapshotFixture() {
  const base = inputRequestedThreadSnapshotFixture();
  return {
    ...base,
    events: {
      ...base.events,
      items: [
        ...base.events.items,
        {
          type: "user_input.requested",
          eventId: "evt_input_desktop_2",
          threadId: "thread_alpha",
          occurredAt: "2026-07-06T00:06:30.000Z",
          request: {
            requestId: "req_input_desktop_2",
            threadId: "thread_alpha",
            title: "Clarify review",
            safeDescription: "Which review should be checked next?",
            placeholder: "Describe the review",
            required: true,
            correlationId: "corr_input_desktop_2",
          },
        },
      ],
    },
  };
}

function multiInputAnsweredThreadSnapshotFixture(inputRequestId: string, correlationId: string) {
  const base = multiInputRequestedThreadSnapshotFixture();
  return {
    ...base,
    thread: {
      ...base.thread,
      status: "running",
      attention: "none",
      updatedAt: inputRequestId === "req_input_desktop_2"
        ? "2026-07-06T00:08:00.000Z"
        : "2026-07-06T00:07:00.000Z",
    },
    events: {
      ...base.events,
      items: [
        ...base.events.items,
        {
          type: "user_input.answered",
          eventId: `evt_${inputRequestId}_answered`,
          threadId: "thread_alpha",
          occurredAt: inputRequestId === "req_input_desktop_2"
            ? "2026-07-06T00:08:00.000Z"
            : "2026-07-06T00:07:00.000Z",
          requestId: inputRequestId,
          correlationId,
        },
      ],
    },
  };
}

describe("AgentWorkspace", () => {
  beforeEach(() => {
    useBoard.setState(useBoard.getInitialState(), true);
    useCodingAgentProjectWorkspace.setState({
      status: "idle",
      runtimeId: null,
      summary: null,
      workspace: null,
      error: null,
      selectedProjectId: null,
      selectedTaskId: null,
      selectedThreadId: null,
      viewMode: "conversation",
    });
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
      fileReadStatus: "idle",
      fileRead: null,
      fileReadError: null,
      fileWriteStatus: "idle",
      fileWriteError: null,
      selectedFilePath: null,
      selectedFileReference: null,
      threadSnapshotStatus: "idle",
      threadSnapshot: null,
      threadSnapshotError: null,
      createStatus: "idle",
      createError: null,
      turnStatus: "idle",
      turnError: null,
      turnRetry: null,
      turnThreadId: null,
      composerFocusRequestId: 0,
      reviewFocusRequestId: 0,
      approvalActionStatus: "idle",
      pendingApprovalId: null,
      approvalActionError: null,
      pendingApprovalKeys: [],
      approvalActionErrors: {},
      inputActionStatus: "idle",
      pendingInputRequestId: null,
      inputActionError: null,
      pendingInputRequestKeys: [],
      inputActionErrors: {},
      activeThreadId: null,
      createdThreadHandles: [],
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
        if (channel === "runtime:get-notification-preferences") {
          return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
        }
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
    await selectInspectorTab("Activity");
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Fix settings route")).toBeTruthy();
    await selectInspectorTab("Terminal");
    expect(screen.getByText("matrix-abc1234")).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {});
  });

  it("hides the prior account summary until the full connection scope refresh completes", async () => {
    const firstSummary = summaryFixture();
    const secondSummary = {
      ...firstSummary,
      activeThreads: {
        ...firstSummary.activeThreads,
        items: firstSummary.activeThreads.items.map((thread) => ({
          ...thread,
          title: "Second account thread",
        })),
      },
    };
    let resolveSecondSummary: ((value: typeof secondSummary) => void) | undefined;
    const pendingSecondSummary = new Promise<typeof secondSummary>((resolve) => {
      resolveSecondSummary = resolve;
    });
    let resolveSecondReviews: ((value: ReturnType<typeof reviewsFixture>) => void) | undefined;
    const pendingSecondReviews = new Promise<ReturnType<typeof reviewsFixture>>((resolve) => {
      resolveSecondReviews = resolve;
    });
    let summaryRequests = 0;
    let reviewRequests = 0;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        summaryRequests += 1;
        return summaryRequests === 1
          ? Promise.resolve(firstSummary)
          : pendingSecondSummary;
      }
      if (channel === "runtime:get-reviews") {
        reviewRequests += 1;
        return reviewRequests === 1
          ? Promise.resolve(reviewsFixture())
          : pendingSecondReviews;
      }
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);
    await selectInspectorTab("Activity");
    await screen.findByText("Fix settings route");
    act(() => {
      useCodingAgentWorkspace.setState({
        createdThreadHandles: [...firstSummary.activeThreads.items],
        reviewsStatus: "ready",
        reviews: reviewsFixture(),
        selectedReviewId: "rev_desktop_1",
        reviewSnapshotStatus: "ready",
        reviewSnapshot: reviewSnapshotFixture(),
        fileReadStatus: "ready",
        fileRead: fileReadFixture(),
        selectedFilePath: "packages/gateway/src/coding-agents/routes.ts",
        selectedFileReference: {
          projectId: "matrix-os",
          worktreeId: "wt_desktop_1",
          path: "packages/gateway/src/coding-agents/routes.ts",
        },
        sourceCommitStatus: "prepared",
        sourceCommit: {
          status: "committed",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          branch: "feature/review-fix",
          changedFileCount: 1,
          safeMessage: "Changes were committed.",
        },
        sourcePullRequestStatus: "ready",
        sourcePullRequest: {
          status: "created",
          number: 808,
          url: "https://github.com/HamedMP/matrix-os/pull/808",
          headBranch: "feature/review-fix",
          baseBranch: "main",
          safeMessage: "Pull request is ready for review.",
        },
      });
    });

    act(() => {
      useConnection.setState({
        handle: "second-account",
        platformHost: "https://second.platform.test",
      });
    });

    await waitFor(() => {
      expect(summaryRequests).toBe(2);
    });
    expect(screen.queryByText("Fix settings route")).toBeNull();
    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    expect(useCodingAgentWorkspace.getState()).toMatchObject({
      createdThreadHandles: [],
      reviewsStatus: "idle",
      reviews: null,
      selectedReviewId: null,
      reviewSnapshotStatus: "idle",
      reviewSnapshot: null,
      fileReadStatus: "idle",
      fileRead: null,
      selectedFilePath: null,
      selectedFileReference: null,
      sourceCommitStatus: "idle",
      sourceCommit: null,
      sourcePullRequestStatus: "idle",
      sourcePullRequest: null,
    });

    await act(async () => {
      resolveSecondSummary?.(secondSummary);
      await pendingSecondSummary;
    });
    await selectInspectorTab("Activity");
    await screen.findByText("Second account thread");
    expect(useCodingAgentWorkspace.getState().reviews).toBeNull();

    await act(async () => {
      resolveSecondReviews?.(reviewsFixture());
      await pendingSecondReviews;
    });
  });

  it("DT-001 through DT-003 hydrates the persistent project and conversation navigator", async () => {
    const baseSummary = summaryFixture({ threadCreate: true });
    const summary = {
      ...baseSummary,
      capabilities: [
        ...baseSummary.capabilities,
        { id: "codingAgentsProjectWorkspace", enabled: true },
        { id: "codingAgentsConversationView", enabled: true },
        { id: "codingAgentsKanbanView", enabled: true },
      ],
      projects: {
        items: [
          { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 3, attentionCount: 0 },
          { id: "website", label: "Website", status: "available", taskCount: 0, threadCount: 0, attentionCount: 0 },
        ],
        hasMore: false,
        limit: 20,
      },
    };
    const workspace = {
      project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 1, threadCount: 3, attentionCount: 0 },
      tasks: {
        items: [{
          id: "task_auth",
          projectId: "matrix-os",
          title: "Harden authentication",
          status: "running",
          priority: "high",
          order: 0,
          threadCount: 2,
          activeThreadCount: 2,
          attentionCount: 0,
        }],
        hasMore: false,
        limit: 100,
      },
      projectThreads: {
        items: [{
          ...baseSummary.activeThreads.items[0],
          id: "thread_audit",
          title: "Audit architecture",
          projectId: "matrix-os",
          attention: "none",
        }],
        hasMore: false,
        limit: 100,
      },
      taskThreads: {
        items: [
          {
            ...baseSummary.activeThreads.items[0],
            id: "thread_plan",
            title: "Plan auth changes",
            projectId: "matrix-os",
            taskId: "task_auth",
            attention: "none",
          },
          {
            ...baseSummary.activeThreads.items[0],
            id: "thread_fix",
            title: "Implement auth changes",
            projectId: "matrix-os",
            taskId: "task_auth",
            attention: "none",
          },
        ],
        hasMore: false,
        limit: 100,
      },
      updatedAt: "2026-07-10T12:00:00.000Z",
    };
    const selectedSnapshot = {
      ...threadSnapshotFixture(),
      thread: workspace.projectThreads.items[0],
    };
    let resolveManualSummary: (value: typeof summary) => void = () => undefined;
    const manualSummary = new Promise<typeof summary>((resolve) => {
      resolveManualSummary = resolve;
    });
    let summaryRequestCount = 0;
    const taskWire = {
      id: "task_auth",
      projectSlug: "matrix-os",
      title: "Harden authentication",
      description: "",
      status: "running",
      priority: "high",
      order: 0,
      parentTaskId: null,
      linkedSessionId: null,
      linkedWorktreeId: null,
      previewIds: [],
      tags: [],
      updatedAt: "2026-07-10T12:00:00.000Z",
      revision: 1,
    };
    const taskGet = vi.fn().mockResolvedValue({ tasks: [taskWire], nextCursor: null });
    const taskPatch = vi.fn().mockResolvedValue({
      task: { ...taskWire, status: "blocked", revision: 2 },
    });
    useConnection.setState({
      api: {
        baseUrl: "https://platform.test",
        get: taskGet,
        getText: vi.fn(),
        post: vi.fn(),
        patch: taskPatch,
        put: vi.fn(),
        delete: vi.fn(),
        putText: vi.fn(),
      } as unknown as ApiClient,
    });
    window.operator.invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "runtime:get-summary") {
        summaryRequestCount += 1;
        if (summaryRequestCount === 3) return manualSummary;
        return Promise.resolve({
          ...summary,
          serverTime: summaryRequestCount === 1
            ? "2026-07-10T12:00:00.000Z"
            : "2026-07-10T12:00:01.000Z",
        });
      }
      if (channel === "runtime:get-project-workspace") return Promise.resolve(workspace);
      if (channel === "runtime:get-thread-snapshot") {
        const threadId = (payload as { threadId: string }).threadId;
        const thread = [
          ...workspace.projectThreads.items,
          ...workspace.taskThreads.items,
        ].find((candidate) => candidate.id === threadId) ?? selectedSnapshot.thread;
        return Promise.resolve({ ...selectedSnapshot, thread });
      }
      if (channel === "runtime:subscribe-thread-events") return Promise.resolve({ ok: true });
      if (channel === "runtime:unsubscribe-thread-events") return Promise.resolve({ ok: true });
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "state:get") return Promise.resolve({ value: null });
      if (channel === "state:set") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project Website" })).toBeTruthy();
    const task = screen.getByRole("group", { name: "Task Harden authentication" });
    expect(within(task).getByRole("button", { name: "Chat Plan auth changes" })).toBeTruthy();
    expect(within(task).getByRole("button", { name: "Chat Implement auth changes" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Project chats" })).getByRole(
      "button",
      { name: "Chat Audit architecture" },
    )).toBeTruthy();

    const identityBeforeKanban = {
      selectedProjectId: useCodingAgentProjectWorkspace.getState().selectedProjectId,
      selectedTaskId: useCodingAgentProjectWorkspace.getState().selectedTaskId,
      selectedThreadId: useCodingAgentProjectWorkspace.getState().selectedThreadId,
    };
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    expect(await screen.findByRole("region", { name: "Matrix OS Kanban" })).toBeTruthy();
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject(identityBeforeKanban);
    await waitFor(() => expect(taskGet).toHaveBeenCalledWith(
      "/api/projects/matrix-os/tasks?limit=100",
    ));
    const move = screen.getByLabelText("Move Harden authentication") as HTMLSelectElement;
    await waitFor(() => expect(move.disabled).toBe(false));
    fireEvent.change(move, { target: { value: "blocked" } });
    await waitFor(() => expect(taskPatch).toHaveBeenCalledWith(
      "/api/projects/matrix-os/tasks/task_auth",
      { status: "blocked", order: 0 },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(useCodingAgentProjectWorkspace.getState()).toMatchObject(identityBeforeKanban);

    await act(async () => {
      await useCodingAgentWorkspace.getState().refresh();
    });
    await waitFor(() => {
      const summaryRequests = vi.mocked(window.operator.invoke).mock.calls.filter(
        ([channel]) => channel === "runtime:get-summary",
      );
      expect(summaryRequests).toHaveLength(2);
    });
    expect(vi.mocked(window.operator.invoke).mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    )).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));
    await waitFor(() => {
      const summaryRequests = vi.mocked(window.operator.invoke).mock.calls.filter(
        ([channel]) => channel === "runtime:get-summary",
      );
      expect(summaryRequests).toHaveLength(3);
    });
    expect(vi.mocked(window.operator.invoke).mock.calls.filter(
      ([channel]) => channel === "runtime:get-project-workspace",
    )).toHaveLength(2);

    resolveManualSummary(summary);
    await waitFor(() => {
      const workspaceRequests = vi.mocked(window.operator.invoke).mock.calls.filter(
        ([channel]) => channel === "runtime:get-project-workspace",
      );
      expect(workspaceRequests).toHaveLength(3);
    });
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_audit");
      expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_audit");
    });

    act(() => {
      useCodingAgentWorkspace.setState({ activeThreadId: "thread_fix" });
    });
    await waitFor(() => {
      expect(useCodingAgentProjectWorkspace.getState().selectedThreadId).toBe("thread_fix");
    });
  });

  it("renders a clear new-run unavailable state when thread creation is disabled", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("Primary");

    expect(screen.getByText("New Run")).toBeTruthy();
    expect(screen.getByText("Agent runs are not available on this runtime yet.")).toBeTruthy();
    expect(screen.queryByLabelText("Agent run prompt")).toBeNull();
  });

  it("groups desktop assistant and tool activity without exposing raw event text", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          {
            type: "assistant.text.delta",
            eventId: "evt_desktop_assistant_delta_1",
            threadId: "thread_alpha",
            messageId: "msg_desktop_grouped",
            delta: "Reading /home/matrix/private with token_sk_live_123.",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            type: "tool.started",
            eventId: "evt_desktop_tool_started",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_grouped",
            displayName: "Read",
            occurredAt: "2026-07-06T00:02:10.000Z",
          },
          {
            type: "tool.output",
            eventId: "evt_desktop_tool_output",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_grouped",
            output: "secret local output from /home/matrix/private",
            truncated: false,
            occurredAt: "2026-07-06T00:02:20.000Z",
          },
          {
            type: "tool.completed",
            eventId: "evt_desktop_tool_completed",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_grouped",
            outcome: "failed",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
          {
            type: "assistant.text.delta",
            eventId: "evt_desktop_assistant_delta_2",
            threadId: "thread_alpha",
            messageId: "msg_desktop_grouped",
            delta: "Finished with private credentials hidden.",
            occurredAt: "2026-07-06T00:02:40.000Z",
          },
          {
            type: "assistant.text.completed",
            eventId: "evt_desktop_assistant_completed",
            threadId: "thread_alpha",
            messageId: "msg_desktop_grouped",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
        ],
      },
    };
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(snapshot);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Assistant message")).toBeTruthy();
    expect(screen.getByText("2 text updates received, complete")).toBeTruthy();
    expect(screen.queryByText("Assistant message complete")).toBeNull();
    expect(screen.getByText("Tool activity")).toBeTruthy();
    expect(screen.getByText("Read completed with errors after receiving output")).toBeTruthy();
    expect(screen.queryByText("Tool output")).toBeNull();
    expect(screen.queryByText("msg_desktop_grouped")).toBeNull();
    expect(screen.queryByText("tool_desktop_grouped")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret local output|private credentials/i)).toBeNull();
    expect(screen.getByText("2026-07-06T00:02:00.000Z")).toBeTruthy();
    expect(screen.getByText("2026-07-06T00:02:10.000Z")).toBeTruthy();
    expect(screen.queryByText("2026-07-06T00:02:30.000Z")).toBeNull();
    expect(screen.queryByText("2026-07-06T00:03:00.000Z")).toBeNull();
    const bodyText = document.body.textContent ?? "";
    expect(bodyText.indexOf("Assistant message")).toBeLessThan(bodyText.indexOf("Tool activity"));
  });

  it("shows bounded safe desktop assistant transcript previews without exposing message ids", async () => {
    const longSafeDelta = "Reviewed the failing shard and found the route test. ".repeat(8);
    const expectedPreview = `1 text update received, complete. ${longSafeDelta.slice(0, 240).trimEnd()}...`;
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          {
            type: "assistant.text.delta",
            eventId: "evt_desktop_assistant_safe_delta",
            threadId: "thread_alpha",
            messageId: "msg_desktop_safe_preview",
            delta: longSafeDelta,
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
          {
            type: "assistant.text.completed",
            eventId: "evt_desktop_assistant_safe_completed",
            threadId: "thread_alpha",
            messageId: "msg_desktop_safe_preview",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
        ],
      },
    };
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(snapshot);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Assistant message")).toBeTruthy();
    expect(screen.getByText(expectedPreview)).toBeTruthy();
    expect(screen.queryByText("msg_desktop_safe_preview")).toBeNull();
    expect(screen.queryByText(/route test\. Reviewed the failing shard and found the route test\.$/)).toBeNull();
  });

  it("renders the selected conversation as durable chat bubbles with a same-thread composer", async () => {
    const conversationSnapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          {
            type: "user.message" as const,
            eventId: "evt_desktop_user_message",
            threadId: "thread_alpha",
            occurredAt: "2026-07-06T00:01:00.000Z",
            messageId: "msg_desktop_user",
            text: "Please inspect the failing desktop test.",
            clientRequestId: "req_desktop_user",
            attachments: [],
          },
          {
            type: "assistant.text.delta" as const,
            eventId: "evt_desktop_agent_message",
            threadId: "thread_alpha",
            occurredAt: "2026-07-06T00:02:00.000Z",
            messageId: "msg_desktop_agent",
            delta: "I found the failing assertion and prepared a focused fix.",
          },
          {
            type: "assistant.text.completed" as const,
            eventId: "evt_desktop_agent_complete",
            threadId: "thread_alpha",
            occurredAt: "2026-07-06T00:02:01.000Z",
            messageId: "msg_desktop_agent",
          },
        ],
      },
    };
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(conversationSnapshot);
      if (channel === "runtime:create-turn") {
        return Promise.resolve({
          ok: true,
          response: {
            threadId: "thread_alpha",
            turnId: "turn_desktop_chat",
            status: "accepted",
            acceptedAt: "2026-07-06T00:03:00.000Z",
          },
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Please inspect the failing desktop test.")).toBeTruthy();
    expect(screen.getByText("I found the failing assertion and prepared a focused fix.")).toBeTruthy();
    const composer = screen.getByLabelText("Message conversation");
    fireEvent.change(composer, { target: { value: "Continue with the focused validation." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:create-turn", {
        threadId: "thread_alpha",
        message: "Continue with the focused validation.",
        clientRequestId: expect.stringMatching(/^req_desktop_/),
      });
    });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
  });

  it("withholds the same-thread composer when the runtime does not support turns", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        return Promise.resolve(summaryFixture({ sameThreadTurns: false }));
      }
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByRole("region", { name: "Conversation Fix settings route" })).toBeTruthy();
    expect(screen.queryByLabelText("Message conversation")).toBeNull();
    expect(screen.getByText("Follow-ups are unavailable on this computer.")).toBeTruthy();
    expect(screen.queryByText(/send a message to continue/i)).toBeNull();
  });

  it("keeps the conversation draft and shows allowlisted recovery copy after a send conflict", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:create-turn") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "thread_busy",
            safeMessage: "Unexpected provider copy",
            retryable: true,
            recoveryActions: ["retry"],
          },
        });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);
    const composer = await screen.findByLabelText("Message conversation");
    fireEvent.change(composer, { target: { value: "Keep this draft for retry." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("This conversation is already running. Wait for it to finish and try again.")).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft for retry.");
    expect(screen.queryByText(/provider copy/i)).toBeNull();
  });

  it("collapses desktop tool activity details until expanded", async () => {
    const snapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          {
            type: "tool.started",
            eventId: "evt_desktop_tool_collapsed_started",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_collapsed",
            displayName: "Run checks",
            kind: "command",
            occurredAt: "2026-07-06T00:02:10.000Z",
          },
          {
            type: "tool.output",
            eventId: "evt_desktop_tool_collapsed_output_1",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_collapsed",
            text: "stdout leaked /home/matrix/private and token_sk_live_123",
            truncated: false,
            occurredAt: "2026-07-06T00:02:20.000Z",
          },
          {
            type: "tool.output",
            eventId: "evt_desktop_tool_collapsed_output_2",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_collapsed",
            text: "stderr leaked /home/matrix/private and token_sk_live_456",
            truncated: true,
            occurredAt: "2026-07-06T00:02:25.000Z",
          },
          {
            type: "tool.completed",
            eventId: "evt_desktop_tool_collapsed_completed",
            threadId: "thread_alpha",
            toolCallId: "tool_desktop_collapsed",
            outcome: "success",
            occurredAt: "2026-07-06T00:02:30.000Z",
          },
        ],
      },
    };
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(snapshot);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Tool activity")).toBeTruthy();
    expect(screen.getByText("Run checks completed successfully after receiving partial output")).toBeTruthy();
    expect(screen.getByText("2 outputs")).toBeTruthy();
    expect(screen.queryByText("Started command")).toBeNull();
    expect(screen.queryByText("Output 1")).toBeNull();
    expect(screen.queryByText("Output 2")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|stdout leaked|stderr leaked|tool_desktop_collapsed/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand tool activity Tool activity" }));

    expect(await screen.findByText("Started command")).toBeTruthy();
    expect(screen.getByText("Output 1")).toBeTruthy();
    expect(screen.getByText("Output received")).toBeTruthy();
    expect(screen.getByText("Output 2")).toBeTruthy();
    expect(screen.getByText("Output received, partial")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|stdout leaked|stderr leaked|tool_desktop_collapsed/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse tool activity Tool activity" }));

    expect(screen.queryByText("Started command")).toBeNull();
    expect(screen.queryByText("Output 1")).toBeNull();
  });

  it("hydrates and updates notification preferences through trusted IPC", async () => {
    let preferenceReads = 0;
    window.operator.invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        preferenceReads += 1;
        return Promise.resolve(preferenceReads === 1
          ? { attentionPush: { approval: true, input: true, failed: false, completed: true } }
          : { attentionPush: { approval: false, input: true, failed: false, completed: true } });
      }
      if (channel === "runtime:update-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: false, input: true, failed: true, completed: true } });
      }
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    await selectInspectorTab("Activity");

    const failedToggle = await screen.findByRole("checkbox", { name: "Failed run alerts" });
    expect((failedToggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(failedToggle);

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:update-notification-preferences", {
        attentionPush: { approval: false, input: true, failed: true, completed: true },
      });
    });
    expect((await screen.findByRole("checkbox", { name: "Failed run alerts" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("marks the active coding-agent thread as current in the thread list", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    await selectInspectorTab("Activity");

    const activeThread = await screen.findByLabelText("Active thread Fix settings route");
    expect(activeThread.getAttribute("aria-current")).toBe("true");
  });

  it("renders gateway-owned attention threads separately from active threads", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(attentionOnlySummaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await selectInspectorTab("Activity");

    expect(await screen.findByText("Needs Attention")).toBeTruthy();
    expect(screen.getByText("Approve deployment")).toBeTruthy();
    expect(screen.getByText("Repair failed run")).toBeTruthy();
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("No active threads.")).toBeTruthy();
  });

  it("renders read-only preview summaries without unsafe origin details", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(previewSummaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await selectInspectorTab("Preview");

    expect(await screen.findByText("Previews")).toBeTruthy();
    expect(screen.getByText("Local web app")).toBeTruthy();
    expect(screen.getByText("http://localhost:3000")).toBeTruthy();
    expect(screen.getByText("Internal service")).toBeTruthy();
    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/internal\.service|token=secret|\/home\/matrix/i)).toBeNull();
  });

  it("opens a desktop preview inspector and only external-opens https origins", async () => {
    window.operator.invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "runtime:get-summary") return Promise.resolve(previewSummaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "shell:open-external") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    await selectInspectorTab("Preview");

    fireEvent.click(await screen.findByRole("button", { name: "Inspect preview Local web app" }));
    expect(screen.getByText("Preview details")).toBeTruthy();
    expect(screen.getByText("Local web app")).toBeTruthy();
    expect(screen.getByText("Open in browser").closest("button")?.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Inspect preview Secure app" }));
    const openButton = screen.getByRole("button", { name: "Open preview Secure app in browser" });
    expect(openButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(openButton);

    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://preview.matrix-os.test",
    });
    expect(window.operator.invoke).not.toHaveBeenCalledWith("shell:open-external", {
      url: "http://localhost:3000",
    });
  });

  it("keeps selected attention-only thread details when refreshed summary still includes the attention thread", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(attentionOnlySummaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(attentionThreadSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await selectInspectorTab("Activity");

    fireEvent.click(await screen.findByRole("button", { name: "Open details for Repair failed run, Failed" }));
    expect(await screen.findByText("Thread details")).toBeTruthy();
    expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_failed");

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_failed");
    });
    expect(screen.getByText("Thread details")).toBeTruthy();
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_failed");
  });

  it("hydrates selected thread details through trusted IPC", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    await selectInspectorTab("Terminal");

    expect(await screen.findByText("Thread details")).toBeTruthy();
    expect(screen.getByText("waiting for approval")).toBeTruthy();
    expect(screen.getAllByText("matrix-abc1234").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("Run the focused desktop tests.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-thread-snapshot", { threadId: "thread_alpha" });
  });

  it("opens review-ready thread events through trusted review IPC", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-notification-preferences") {
        return Promise.resolve({ attentionPush: { approval: true, input: true, failed: true, completed: true } });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(reviewReadyThreadSnapshotFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Review ready")).toBeTruthy();
    expect(screen.getByText("2 files changed, +12 -4, partial")).toBeTruthy();
    await selectInspectorTab("Activity");
    fireEvent.click(screen.getByRole("button", { name: "Open review from thread" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-review-snapshot", {
        reviewId: "rev_desktop_1",
      });
    });
    expect(screen.getByRole("tab", { name: /^Changes\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("PR #758 review details")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
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

  it("subscribes through trusted IPC and applies live thread events", async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:subscribe-thread-events") return Promise.resolve({ ok: true });
      return Promise.reject(new Error("unexpected channel"));
    });
    window.operator.on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      listeners[channel] = callback;
      return () => {
        delete listeners[channel];
      };
    });

    await useCodingAgentWorkspace.getState().loadThreadSnapshot("thread_alpha");

    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:subscribe-thread-events", {
      threadId: "thread_alpha",
      cursor: "evt_approval_desktop_1",
    });

    listeners["runtime:thread-event"]?.({
      threadId: "thread_alpha",
      event: {
        type: "approval.resolved",
        eventId: "evt_approval_desktop_stream",
        threadId: "thread_alpha",
        occurredAt: "2026-07-06T00:05:00.000Z",
        approvalId: "appr_desktop_1",
        decision: "approve",
      },
    });

    const state = useCodingAgentWorkspace.getState();
    expect(state.threadSnapshot?.thread.status).toBe("running");
    expect(state.threadSnapshot?.thread.attention).toBe("none");
    expect(state.threadSnapshot?.events.items.map((event) => event.eventId)).toContain("evt_approval_desktop_stream");
  });

  it("does not let older replayed stream events regress a newer thread snapshot", async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    const completedSnapshot = {
      ...threadSnapshotFixture(),
      thread: {
        ...threadSnapshotFixture().thread,
        status: "completed",
        attention: "completed",
        updatedAt: "2026-07-06T00:08:00.000Z",
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(completedSnapshot);
      if (channel === "runtime:subscribe-thread-events") return Promise.resolve({ ok: true });
      return Promise.reject(new Error("unexpected channel"));
    });
    window.operator.on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      listeners[channel] = callback;
      return () => undefined;
    });
    await useCodingAgentWorkspace.getState().loadThreadSnapshot("thread_alpha");

    listeners["runtime:thread-event"]?.({
      threadId: "thread_alpha",
      event: {
        type: "approval.resolved",
        eventId: "evt_approval_desktop_1",
        threadId: "thread_alpha",
        occurredAt: "2026-07-06T00:04:00.000Z",
        approvalId: "appr_desktop_1",
        decision: "approve",
      },
    });

    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.status).toBe("completed");
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.attention).toBe("completed");
  });

  it("keeps live stream events that arrive while a snapshot load is settling", async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    window.operator.on = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      listeners[channel] = callback;
      return () => undefined;
    });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:subscribe-thread-events") {
        listeners["runtime:thread-event"]?.({
          threadId: "thread_alpha",
          event: {
            type: "thread.completed",
            eventId: "evt_desktop_completed_live",
            threadId: "thread_alpha",
            occurredAt: "2026-07-06T00:07:00.000Z",
            outcome: "completed",
          },
        });
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    await useCodingAgentWorkspace.getState().loadThreadSnapshot("thread_alpha");

    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.status).toBe("completed");
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.events.items.map((event) => event.eventId))
      .toContain("evt_desktop_completed_live");
  });

  it("removes a resolved approval thread from the desktop attention summary", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:submit-approval-decision") return Promise.resolve(resolvedAttentionApprovalSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      summary: attentionOnlySummaryFixture(),
      activeThreadId: "thread_approval",
      threadSnapshotStatus: "ready",
      threadSnapshot: {
        ...threadSnapshotFixture(),
        thread: {
          ...threadSnapshotFixture().thread,
          id: "thread_approval",
          title: "Approve deployment",
          attention: "approval_required",
        },
      },
    });

    await useCodingAgentWorkspace.getState().submitApprovalDecision({
      threadId: "thread_approval",
      approvalId: "appr_desktop_1",
      decision: "approve",
      correlationId: "corr_desktop_1",
    });

    const state = useCodingAgentWorkspace.getState();
    expect(state.threadSnapshot?.thread.attention).toBe("none");
    expect(state.summary?.attentionThreads.items.map((thread) => thread.id)).toEqual(["thread_failed"]);
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

  it("does not apply pending approval state to another thread with the same approval id", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string, payload?: { approvalId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:submit-approval-decision" && payload?.approvalId === "appr_desktop_1") {
        return new Promise(() => undefined);
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const alphaApprove = await screen.findByRole("button", { name: /approve run tests/i });
    fireEvent.click(alphaApprove);
    await waitFor(() => expect((alphaApprove as HTMLButtonElement).disabled).toBe(true));

    await act(async () => {
      useCodingAgentWorkspace.setState({
        activeThreadId: "thread_beta",
        threadSnapshotStatus: "ready",
        threadSnapshot: betaApprovalSameIdThreadSnapshotFixture(),
      });
    });

    const betaApprove = await screen.findByRole("button", { name: /approve run beta tests/i });
    expect((betaApprove as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Sending...")).toBeNull();
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

  it("does not apply approval errors to another thread with the same approval id", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string, payload?: { approvalId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(threadSnapshotFixture());
      if (channel === "runtime:submit-approval-decision" && payload?.approvalId === "appr_desktop_1") {
        return Promise.reject(new Error("provider leaked /home/matrix"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: /approve run tests/i }));
    await screen.findByText("Approval could not be sent. Try again.");

    await act(async () => {
      useCodingAgentWorkspace.setState({
        activeThreadId: "thread_beta",
        threadSnapshotStatus: "ready",
        threadSnapshot: betaApprovalSameIdThreadSnapshotFixture(),
      });
    });

    await screen.findByRole("button", { name: /approve run beta tests/i });
    expect(screen.queryByText("Approval could not be sent. Try again.")).toBeNull();
  });

  it("submits user input answers through trusted IPC and refreshes the thread details", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    const answeredSnapshot = inputAnsweredThreadSnapshotFixture();
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(inputRequestedThreadSnapshotFixture());
      if (channel === "runtime:submit-input-answer") return Promise.resolve(answeredSnapshot);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const input = await screen.findByLabelText(/answer clarify failure/i);
    fireEvent.change(input, { target: { value: "Run the focused desktop workspace test." } });
    fireEvent.click(screen.getByRole("button", { name: /send clarify failure/i }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:submit-input-answer", {
        threadId: "thread_alpha",
        inputRequestId: "req_input_desktop_1",
        answer: "Run the focused desktop workspace test.",
        correlationId: "corr_input_desktop_1",
        clientRequestId: expect.stringMatching(/^req_desktop_/),
      });
    });
    expect(await screen.findByText("Input answered")).toBeTruthy();
    expect(screen.queryByLabelText(/answer clarify failure/i)).toBeNull();
  });

  it("removes a resolved input thread from the desktop attention summary", async () => {
    const attentionSummary = attentionOnlySummaryFixture();
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:submit-input-answer") return Promise.resolve(resolvedAttentionInputSnapshotFixture());
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      summary: {
        ...attentionSummary,
        attentionThreads: {
          ...attentionSummary.attentionThreads,
          items: [
            {
              ...attentionSummary.attentionThreads.items[0],
              attention: "input_required",
              status: "waiting_for_input",
            },
            attentionSummary.attentionThreads.items[1],
          ],
        },
      },
      activeThreadId: "thread_approval",
      threadSnapshotStatus: "ready",
      threadSnapshot: {
        ...inputRequestedThreadSnapshotFixture(),
        thread: {
          ...inputRequestedThreadSnapshotFixture().thread,
          id: "thread_approval",
          title: "Approve deployment",
        },
      },
    });

    await useCodingAgentWorkspace.getState().submitInputAnswer({
      threadId: "thread_approval",
      inputRequestId: "req_input_desktop_1",
      answer: "Continue.",
      correlationId: "corr_input_desktop_1",
    });

    const state = useCodingAgentWorkspace.getState();
    expect(state.threadSnapshot?.thread.attention).toBe("none");
    expect(state.summary?.attentionThreads.items.map((thread) => thread.id)).toEqual(["thread_failed"]);
  });

  it("shows input submission errors only on the failed input row", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    window.operator.invoke = vi.fn((channel: string, payload?: { inputRequestId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(multiInputRequestedThreadSnapshotFixture());
      if (channel === "runtime:submit-input-answer" && payload?.inputRequestId === "req_input_desktop_1") {
        return Promise.reject(new Error("provider leaked /home/matrix"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const firstInput = await screen.findByLabelText(/answer clarify failure/i);
    fireEvent.change(firstInput, { target: { value: "Run workspace tests." } });
    fireEvent.click(screen.getByRole("button", { name: /send clarify failure/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Input could not be sent. Try again.")).toHaveLength(1);
    });
  });

  it("keeps independent input prompts actionable while another prompt is pending", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });
    let resolveFirstInput: ((snapshot: ReturnType<typeof multiInputAnsweredThreadSnapshotFixture>) => void) | null = null;
    window.operator.invoke = vi.fn((channel: string, payload?: { inputRequestId?: string }) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(multiInputRequestedThreadSnapshotFixture());
      if (channel === "runtime:submit-input-answer" && payload?.inputRequestId === "req_input_desktop_1") {
        return new Promise((resolve) => {
          resolveFirstInput = resolve;
        });
      }
      if (channel === "runtime:submit-input-answer" && payload?.inputRequestId === "req_input_desktop_2") {
        return Promise.resolve(multiInputAnsweredThreadSnapshotFixture("req_input_desktop_2", "corr_input_desktop_2"));
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    fireEvent.change(await screen.findByLabelText(/answer clarify failure/i), { target: { value: "Run workspace tests." } });
    fireEvent.change(await screen.findByLabelText(/answer clarify review/i), { target: { value: "Check review summary." } });
    const firstSend = screen.getByRole("button", { name: /send clarify failure/i });
    const secondSend = screen.getByRole("button", { name: /send clarify review/i });
    fireEvent.click(firstSend);
    await waitFor(() => expect((firstSend as HTMLButtonElement).disabled).toBe(true));
    expect((secondSend as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(secondSend);

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:submit-input-answer", expect.objectContaining({
        inputRequestId: "req_input_desktop_2",
      }));
    });
    await screen.findByText("Input answered");
    expect(screen.queryByLabelText(/answer clarify review/i)).toBeNull();
    await act(async () => {
      resolveFirstInput?.(multiInputAnsweredThreadSnapshotFixture("req_input_desktop_1", "corr_input_desktop_1"));
      await Promise.resolve();
    });
    expect(screen.queryByLabelText(/answer clarify review/i)).toBeNull();
  });

  it("clears selected thread details when the refreshed summary no longer includes the thread", async () => {
    useCodingAgentWorkspace.setState({ activeThreadId: "thread_alpha" });

    render(<AgentWorkspace />);

    await selectInspectorTab("Activity");

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

    await selectInspectorTab("Activity");

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

    await selectInspectorTab("Activity");

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

    await selectInspectorTab("Activity");

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

  it("loads bounded file content from trusted IPC when a review file is selected", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ files: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:get-file-content") return Promise.resolve(fileReadFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    fireEvent.click(screen.getByRole("button", {
      name: /Open file packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    }));

    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    expect(await screen.findByText("export const safeRoute = true;")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("browses and searches review workspace files through trusted IPC", async () => {
    const browse = {
      directory: {
        path: "packages",
        kind: "directory",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      entries: {
        items: [
          {
            path: "packages/gateway",
            kind: "directory",
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
          {
            path: "packages/README.md",
            kind: "file",
            sizeBytes: 24,
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };
    const search = {
      matches: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            kind: "file",
            sizeBytes: 37,
            updatedAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 20,
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ files: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:browse-files") return Promise.resolve(browse);
      if (channel === "runtime:search-files") return Promise.resolve(search);
      if (channel === "runtime:get-file-content") return Promise.resolve(fileReadFixture());
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open review PR #758" }));
    });
    await screen.findByText("PR #758 review details");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse workspace files for PR #758" }));
    });

    await screen.findByText("packages/gateway");
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      limit: 20,
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search review workspace files"), {
        target: { value: "routes" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run review workspace file search" }));
    });

    expect((await screen.findAllByText("packages/gateway/src/coding-agents/routes.ts")).length).toBeGreaterThanOrEqual(2);
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:search-files", {
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      query: "routes",
      limit: 20,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open file packages/gateway/src/coding-agents/routes.ts from search results" }));
    });
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("saves edited file content through trusted IPC without exposing credentials", async () => {
    const savedFile = {
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 38,
        etag: "sha256_desktop_file_next",
        updatedAt: "2026-07-06T00:04:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 38,
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ files: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:get-file-content") return Promise.resolve(fileReadFixture());
      if (channel === "runtime:save-file-content") return Promise.resolve(savedFile);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    fireEvent.click(screen.getByRole("button", {
      name: /Open file packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    }));
    const editor = await screen.findByLabelText("Edit file packages/gateway/src/coding-agents/routes.ts");
    fireEvent.change(editor, { target: { value: "export const safeRoute = false;\n" } });
    fireEvent.click(screen.getByRole("button", {
      name: /Save file packages\/gateway\/src\/coding-agents\/routes\.ts/i,
    }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:save-file-content", expect.objectContaining({
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
        path: "packages/gateway/src/coding-agents/routes.ts",
        content: "export const safeRoute = false;\n",
        encoding: "utf8",
        baseEtag: "sha256_desktop_file",
      }));
    });
    const saveCall = vi.mocked(window.operator.invoke).mock.calls.find(([channel]) => channel === "runtime:save-file-content");
    expect(saveCall?.[1]).toEqual(expect.objectContaining({
      clientRequestId: expect.stringMatching(/^req_desktop_/),
    }));
    expect(JSON.stringify(saveCall?.[1])).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect((screen.getByLabelText("Edit file packages/gateway/src/coding-agents/routes.ts") as HTMLTextAreaElement).value)
      .toBe("export const safeRoute = false;\n");
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("prepares a source-control commit for reviewed files through trusted IPC", async () => {
    const prepared = {
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/review-fix",
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ sourceControl: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:prepare-source-commit") return Promise.resolve(prepared);
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    fireEvent.click(screen.getByRole("button", { name: "Prepare commit for review PR #758" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:prepare-source-commit", expect.objectContaining({
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
        paths: ["packages/gateway/src/coding-agents/routes.ts"],
      }));
    });
    const commitCall = vi.mocked(window.operator.invoke).mock.calls.find(([channel]) => channel === "runtime:prepare-source-commit");
    expect(commitCall?.[1]).toEqual(expect.objectContaining({
      message: expect.stringMatching(/review/i),
      clientRequestId: expect.stringMatching(/^req_desktop_/),
    }));
    expect(JSON.stringify(commitCall?.[1])).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Commit prepared")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores stale desktop commit completions after another review opens the same worktree", async () => {
    const commitResult = deferred<{
      status: "committed";
      commitSha: string;
      branch: string;
      changedFileCount: number;
      safeMessage: string;
    }>();
    const secondReview = {
      ...reviewsFixture().items[0],
      id: "rev_desktop_2",
      pullRequestNumber: 759,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };
    const reviews = {
      ...reviewsFixture(),
      items: [reviewsFixture().items[0], secondReview],
    };
    const firstSnapshot = reviewSnapshotFixture();
    const secondSnapshot = {
      ...reviewSnapshotFixture(),
      review: secondReview,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };

    window.operator.invoke = vi.fn((channel: string, request?: unknown) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ sourceControl: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviews);
      if (channel === "runtime:get-review-snapshot") {
        return Promise.resolve((request as { reviewId?: string }).reviewId === "rev_desktop_2" ? secondSnapshot : firstSnapshot);
      }
      if (channel === "runtime:prepare-source-commit") return commitResult.promise;
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("PR #758 review details");
    fireEvent.click(screen.getByRole("button", { name: "Prepare commit for review PR #758" }));
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #759/i }));
    await screen.findByText("PR #759 review details");

    await act(async () => {
      commitResult.resolve({
        status: "committed",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        branch: "feature/review-fix",
        changedFileCount: 1,
        safeMessage: "Changes were committed.",
      });
      await commitResult.promise;
    });

    expect(screen.queryByText("Commit prepared")).toBeNull();
    expect(screen.queryByText(/Source commit could not be prepared/i)).toBeNull();
  });

  it("creates a source-control pull request for reviewed files through trusted IPC", async () => {
    const pullRequest = {
      status: "created",
      number: 808,
      url: "https://github.com/HamedMP/matrix-os/pull/808",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ sourceControl: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:get-review-snapshot") return Promise.resolve(reviewSnapshotFixture());
      if (channel === "runtime:create-source-pull-request") return Promise.resolve(pullRequest);
      if (channel === "shell:open-external") return Promise.resolve({ ok: true });
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("matrix-os");
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("packages/gateway/src/coding-agents/routes.ts");
    fireEvent.click(screen.getByRole("button", { name: "Create pull request for review PR #758" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith("runtime:create-source-pull-request", expect.objectContaining({
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
      }));
    });
    const pullRequestCall = vi.mocked(window.operator.invoke).mock.calls.find(([channel]) => channel === "runtime:create-source-pull-request");
    expect(pullRequestCall?.[1]).toEqual(expect.objectContaining({
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: expect.stringMatching(/^req_desktop_/),
    }));
    expect(JSON.stringify(pullRequestCall?.[1])).not.toMatch(/token|bearer|secret/i);
    expect(await screen.findByText("Pull request ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open created pull request #808" }));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://github.com/HamedMP/matrix-os/pull/808",
    });
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("ignores stale desktop pull request completions after another review opens the same worktree", async () => {
    const pullRequestResult = deferred<{
      status: "created";
      number: number;
      url: string;
      headBranch: string;
      baseBranch: string;
      safeMessage: string;
    }>();
    const secondReview = {
      ...reviewsFixture().items[0],
      id: "rev_desktop_2",
      pullRequestNumber: 759,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };
    const reviews = {
      ...reviewsFixture(),
      items: [reviewsFixture().items[0], secondReview],
    };
    const firstSnapshot = reviewSnapshotFixture();
    const secondSnapshot = {
      ...reviewSnapshotFixture(),
      review: secondReview,
      updatedAt: "2026-07-06T00:05:00.000Z",
    };

    window.operator.invoke = vi.fn((channel: string, request?: unknown) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ sourceControl: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviews);
      if (channel === "runtime:get-review-snapshot") {
        return Promise.resolve((request as { reviewId?: string }).reviewId === "rev_desktop_2" ? secondSnapshot : firstSnapshot);
      }
      if (channel === "runtime:create-source-pull-request") return pullRequestResult.promise;
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: /Open review PR #758/i }));
    await screen.findByText("PR #758 review details");
    fireEvent.click(screen.getByRole("button", { name: "Create pull request for review PR #758" }));
    fireEvent.click(screen.getByRole("button", { name: /Open review PR #759/i }));
    await screen.findByText("PR #759 review details");

    await act(async () => {
      pullRequestResult.resolve({
        status: "created",
        number: 808,
        url: "https://github.com/HamedMP/matrix-os/pull/808",
        headBranch: "feature/review-fix",
        baseBranch: "main",
        safeMessage: "Pull request is ready for review.",
      });
      await pullRequestResult.promise;
    });

    expect(screen.queryByText("Pull request ready")).toBeNull();
    expect(screen.queryByText(/Pull request could not be created/i)).toBeNull();
  });

  it("ignores stale desktop save completions after another worktree opens the same path", async () => {
    let resolveSave: ((value: {
      metadata: {
        path: string;
        kind: "file";
        sizeBytes: number;
        etag: string;
        updatedAt: string;
      };
      encoding: "utf8";
      writtenBytes: number;
    }) => void) | null = null;
    const secondWorktreeFile = {
      ...fileReadFixture(),
      metadata: {
        ...fileReadFixture().metadata,
        etag: "sha256_desktop_file_second_worktree",
      },
      content: "export const safeRoute = 'second';\n",
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:save-file-content") {
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      if (channel === "runtime:get-file-content") return Promise.resolve(secondWorktreeFile);
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      selectedFilePath: "packages/gateway/src/coding-agents/routes.ts",
      selectedFileReference: {
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
        path: "packages/gateway/src/coding-agents/routes.ts",
      },
      fileReadStatus: "ready",
      fileRead: fileReadFixture(),
      fileReadError: null,
      fileWriteStatus: "idle",
      fileWriteError: null,
    });

    const save = useCodingAgentWorkspace.getState().saveFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      baseEtag: "sha256_desktop_file",
    });
    await useCodingAgentWorkspace.getState().loadFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_2",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    resolveSave?.({
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 32,
        etag: "sha256_desktop_file_saved",
        updatedAt: "2026-07-06T00:05:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 32,
    });
    await save;

    const state = useCodingAgentWorkspace.getState();
    expect(state.selectedFileReference).toEqual({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_2",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    expect(state.fileRead?.metadata.etag).toBe("sha256_desktop_file_second_worktree");
    expect(state.fileRead?.content).toBe("export const safeRoute = 'second';\n");
    expect(state.fileWriteStatus).toBe("idle");
    expect(state.fileWriteError).toBeNull();
  });

  it("does not let stale save completions clear the current file save state", async () => {
    const firstSave = deferred<{
      metadata: {
        path: string;
        kind: "file";
        sizeBytes: number;
        etag: string;
        updatedAt: string;
      };
      encoding: "utf8";
      writtenBytes: number;
    }>();
    const secondSave = deferred<{
      metadata: {
        path: string;
        kind: "file";
        sizeBytes: number;
        etag: string;
        updatedAt: string;
      };
      encoding: "utf8";
      writtenBytes: number;
    }>();
    const secondWorktreeFile = {
      ...fileReadFixture(),
      metadata: {
        ...fileReadFixture().metadata,
        etag: "sha256_desktop_file_second_worktree",
      },
      content: "export const safeRoute = 'second';\n",
    };
    window.operator.invoke = vi.fn((channel: string, payload: unknown) => {
      if (channel === "runtime:save-file-content") {
        return (payload as { worktreeId?: string }).worktreeId === "wt_desktop_1"
          ? firstSave.promise
          : secondSave.promise;
      }
      if (channel === "runtime:get-file-content") return Promise.resolve(secondWorktreeFile);
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      selectedFilePath: "packages/gateway/src/coding-agents/routes.ts",
      selectedFileReference: {
        projectId: "matrix-os",
        worktreeId: "wt_desktop_1",
        path: "packages/gateway/src/coding-agents/routes.ts",
      },
      fileReadStatus: "ready",
      fileRead: fileReadFixture(),
      fileReadError: null,
      fileWriteStatus: "idle",
      fileWriteError: null,
    });

    const staleSave = useCodingAgentWorkspace.getState().saveFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_1",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      baseEtag: "sha256_desktop_file",
    });
    await useCodingAgentWorkspace.getState().loadFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_2",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
    const activeSave = useCodingAgentWorkspace.getState().saveFileContent({
      projectId: "matrix-os",
      worktreeId: "wt_desktop_2",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = true;\n",
      baseEtag: "sha256_desktop_file_second_worktree",
    });

    firstSave.resolve({
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 32,
        etag: "sha256_desktop_file_saved",
        updatedAt: "2026-07-06T00:05:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 32,
    });
    await staleSave;

    expect(useCodingAgentWorkspace.getState().fileWriteStatus).toBe("saving");

    secondSave.resolve({
      metadata: {
        path: "packages/gateway/src/coding-agents/routes.ts",
        kind: "file",
        sizeBytes: 31,
        etag: "sha256_desktop_file_second_saved",
        updatedAt: "2026-07-06T00:06:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 31,
    });
    await activeSave;

    expect(useCodingAgentWorkspace.getState().fileWriteStatus).toBe("saved");
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

  it("applies navigator project context without appending an empty seed prompt", () => {
    const draft = mergeComposerSeed(
      {
        providerId: "codex",
        prompt: "Keep my in-progress instructions.",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
      },
      {
        providerId: "codex",
        prompt: "",
        mode: "default",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        projectId: "matrix-os",
        taskId: "task_auth",
      },
    );

    expect(draft.prompt).toBe("Keep my in-progress instructions.");
    expect(draft.projectId).toBe("matrix-os");
    expect(draft.taskId).toBe("task_auth");
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
    expect(await screen.findByText("Thread details")).toBeTruthy();
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "thread")).toBe(false);
  });

  it("keeps a desktop-created thread detail when the active summary window drops it", async () => {
    let summary = summaryFixture({ threadCreate: true });
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summary);
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:create-thread") {
        return Promise.resolve({
          thread: {
            id: "thread_created_handle",
            providerId: "codex",
            title: "Investigate retained workspace handle",
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
      target: { value: "Investigate retained workspace handle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByText("Investigate retained workspace handle")).toBeTruthy();

    summary = {
      ...summary,
      activeThreads: {
        ...summary.activeThreads,
        items: [],
      },
      attentionThreads: {
        ...summary.attentionThreads,
        items: [],
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_created_handle");
    });
    expect(screen.getByText("Thread details")).toBeTruthy();
    expect(screen.getAllByText("Investigate retained workspace handle").length).toBeGreaterThan(0);
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "thread")).toBe(false);
  });

  it("renders a desktop-created thread reopen handle after another thread is selected", async () => {
    let summary = summaryFixture({ threadCreate: true });
    const createdSnapshot = {
      thread: {
        id: "thread_created_handle",
        providerId: "codex",
        title: "Investigate retained workspace handle",
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
    };
    window.operator.invoke = vi.fn((channel: string, payload?: unknown) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summary);
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      if (channel === "runtime:create-thread") return Promise.resolve(createdSnapshot);
      if (channel === "runtime:get-thread-snapshot") {
        const threadId = (payload as { threadId?: string } | undefined)?.threadId;
        return Promise.resolve(threadId === "thread_created_handle" ? createdSnapshot : threadSnapshotFixture());
      }
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    await screen.findByLabelText("Agent run prompt");
    fireEvent.change(screen.getByLabelText("Agent run prompt"), {
      target: { value: "Investigate retained workspace handle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByText("Investigate retained workspace handle")).toBeTruthy();
    await selectInspectorTab("Activity");
    fireEvent.click(screen.getByRole("button", { name: "Open details for Fix settings route" }));
    await waitFor(() => {
      expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_alpha");
    });

    summary = {
      ...summary,
      activeThreads: {
        ...summary.activeThreads,
        items: [],
      },
      attentionThreads: {
        ...summary.attentionThreads,
        items: [],
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Refresh agent workspace" }));

    expect(await screen.findByText("Created Runs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open created run Investigate retained workspace handle" }));

    await waitFor(() => {
      expect(window.operator.invoke).toHaveBeenCalledWith(
        "runtime:get-thread-snapshot",
        { threadId: "thread_created_handle" },
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText("Investigate retained workspace handle").length).toBeGreaterThan(0);
    });
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "thread")).toBe(false);
  });

  it("focuses the desktop composer prompt when a new-run focus request arrives", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture({ threadCreate: true }));
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unexpected channel"));
    });

    render(<AgentWorkspace />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    expect(document.activeElement).not.toBe(prompt);

    act(() => {
      useCodingAgentWorkspace.getState().requestComposerFocus();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(prompt);
    });
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

  it("discards an in-flight thread create that settles after the computer changes", async () => {
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
      prompt: "Stale create after switch",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
    } as const;

    const pending = useCodingAgentWorkspace.getState().createThread(draft);
    reconcileDesktopRuntimeChange({ disposeRuntimeAttachments: vi.fn() });
    resolveCreate({
      thread: {
        id: "thread_stale_1",
        providerId: "codex",
        title: "Stale create after switch",
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

    await expect(pending).resolves.toBeNull();
    expect(useCodingAgentWorkspace.getState().activeThreadId).toBeNull();
    expect(useCodingAgentWorkspace.getState().threadSnapshot).toBeNull();
    expect(useCodingAgentWorkspace.getState().createdThreadHandles).toEqual([]);
  });

  it("sends a same-thread message and refreshes only the selected conversation", async () => {
    const refreshedSnapshot = {
      ...threadSnapshotFixture(),
      events: {
        ...threadSnapshotFixture().events,
        items: [
          ...threadSnapshotFixture().events.items,
          {
            type: "user.message" as const,
            eventId: "evt_user_message_1",
            threadId: "thread_alpha",
            occurredAt: "2026-07-06T00:05:00.000Z",
            messageId: "msg_desktop_1",
            text: "Continue with the focused tests.",
            clientRequestId: "req_desktop_turn_1",
            turnId: "turn_desktop_1",
            attachments: [],
          },
        ],
      },
    };
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:create-turn") {
        return Promise.resolve({
          ok: true,
          response: {
            threadId: "thread_alpha",
            turnId: "turn_desktop_1",
            status: "accepted",
            acceptedAt: "2026-07-06T00:05:00.000Z",
          },
        });
      }
      if (channel === "runtime:get-thread-snapshot") return Promise.resolve(refreshedSnapshot);
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_alpha",
      threadSnapshotStatus: "ready",
      threadSnapshot: threadSnapshotFixture(),
    });

    await expect(useCodingAgentWorkspace.getState().sendThreadMessage({
      threadId: "thread_alpha",
      message: "Continue with the focused tests.",
    })).resolves.toBe(true);

    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:create-turn", {
      threadId: "thread_alpha",
      message: "Continue with the focused tests.",
      clientRequestId: expect.stringMatching(/^req_desktop_/),
    });
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.events.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "user.message" })]));
    expect(useCodingAgentWorkspace.getState().turnRetry).toBeNull();
  });

  it("reuses a turn request id for an identical retry and rotates it after editing", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:create-turn") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "thread_busy",
            safeMessage: "Unexpected upstream copy",
            retryable: true,
            recoveryActions: ["retry"],
          },
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_alpha",
      threadSnapshotStatus: "ready",
      threadSnapshot: threadSnapshotFixture(),
    });

    const send = (message: string) => useCodingAgentWorkspace.getState().sendThreadMessage({
      threadId: "thread_alpha",
      message,
    });
    await send("Continue with the focused tests.");
    await send("Continue with the focused tests.");
    await send("Continue with the focused tests, then report back.");

    const requests = vi.mocked(window.operator.invoke).mock.calls
      .filter(([channel]) => channel === "runtime:create-turn")
      .map(([, request]) => request as { clientRequestId: string });
    expect(requests[0]?.clientRequestId).toBe(requests[1]?.clientRequestId);
    expect(requests[2]?.clientRequestId).not.toBe(requests[1]?.clientRequestId);
    expect(useCodingAgentWorkspace.getState().turnError)
      .toBe("This conversation is already running. Wait for it to finish and try again.");
    expect(useCodingAgentWorkspace.getState().turnError).not.toContain("upstream");
  });

  it("does not refresh or reopen a conversation after selection changes during send", async () => {
    let resolveTurn: ((value: unknown) => void) | null = null;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:create-turn") {
        return new Promise((resolve) => {
          resolveTurn = resolve;
        });
      }
      return Promise.reject(new Error("unexpected channel"));
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_alpha",
      threadSnapshotStatus: "ready",
      threadSnapshot: threadSnapshotFixture(),
    });

    const pending = useCodingAgentWorkspace.getState().sendThreadMessage({
      threadId: "thread_alpha",
      message: "Continue with the focused tests.",
    });
    useCodingAgentWorkspace.setState({
      activeThreadId: "thread_beta",
      threadSnapshotStatus: "ready",
      threadSnapshot: betaThreadSnapshotFixture(),
    });
    resolveTurn?.({
      ok: true,
      response: {
        threadId: "thread_alpha",
        turnId: "turn_desktop_1",
        status: "accepted",
        acceptedAt: "2026-07-06T00:05:00.000Z",
      },
    });
    await pending;

    expect(useCodingAgentWorkspace.getState().activeThreadId).toBe("thread_beta");
    expect(useCodingAgentWorkspace.getState().threadSnapshot?.thread.id).toBe("thread_beta");
    expect(window.operator.invoke).not.toHaveBeenCalledWith(
      "runtime:get-thread-snapshot",
      expect.anything(),
    );
  });

  it("shows a generic safe error when summary refresh fails", async () => {
    let summaryRequests = 0;
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel === "runtime:get-summary") {
        summaryRequests += 1;
        return summaryRequests === 1
          ? Promise.reject(new Error("connect ECONNREFUSED /home/matrix/private"))
          : Promise.resolve(summaryFixture());
      }
      if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
      return Promise.reject(new Error("unavailable"));
    });

    render(<AgentWorkspace />);

    await screen.findByText("Runtime summary unavailable");
    expect(screen.queryByText(/home\/matrix/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await selectInspectorTab("Activity");
    await screen.findByText("Fix settings route");
  });
});
