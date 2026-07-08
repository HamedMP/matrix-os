// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace from "../../desktop/src/renderer/src/features/coding-agents/AgentWorkspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function summaryFixture({ threadCreate = false }: { threadCreate?: boolean } = {}) {
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
          name: "matrix-abc1234",
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

describe("AgentWorkspace", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({
      status: "idle",
      summary: null,
      error: null,
      reviewsStatus: "idle",
      reviews: null,
      reviewsError: null,
      createStatus: "idle",
      createError: null,
      activeThreadId: null,
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "runtime:get-summary") return Promise.resolve(summaryFixture());
        if (channel === "runtime:get-reviews") return Promise.resolve(reviewsFixture());
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

  it("renders read-only review summaries through trusted IPC", async () => {
    render(<AgentWorkspace />);

    await screen.findByText("Review");
    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByText(/PR #758/)).toBeTruthy();
    expect(screen.getByText("1 high")).toBeTruthy();
    expect(screen.getByText(/Round 2 of 3/)).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-reviews", {});
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
