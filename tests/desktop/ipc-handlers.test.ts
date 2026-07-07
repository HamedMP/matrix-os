import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpcHandlers, type HandlerContext } from "../../desktop/src/main/ipc/handlers";

type IpcListener = (event: unknown, payload: unknown) => Promise<unknown> | unknown;

function makeHarness(overrides: Partial<HandlerContext> = {}) {
  const listeners = new Map<string, IpcListener>();
  const ipcMain = {
    handle: vi.fn((channel: string, listener: IpcListener) => {
      listeners.set(channel, listener);
    }),
  };
  const ctx = {
    auth: {
      startDeviceFlow: vi.fn(),
      poll: vi.fn(),
      getStatus: vi.fn(),
      signOut: vi.fn(),
      expireSession: vi.fn(),
      selectRuntime: vi.fn(),
    },
    store: {
      get: vi.fn(),
      setUnknown: vi.fn(),
      setPanelLayout: vi.fn(),
    },
    embeds: {
      open: vi.fn(),
      setBounds: vi.fn(),
      setActive: vi.fn(),
      close: vi.fn(),
      retryAuth: vi.fn(),
    },
    openExternal: vi.fn(),
    setBadgeCount: vi.fn(),
    notify: vi.fn(),
    onRuntimeChanged: vi.fn(),
    getUpdateStatus: vi.fn(() => "disabled"),
    fetchRuntimeSummary: vi.fn(),
    fetchReviewSummaries: vi.fn(),
    fetchReviewSnapshot: vi.fn(),
    fetchFileContent: vi.fn(),
    fetchThreadSnapshot: vi.fn(),
    submitApprovalDecision: vi.fn(),
    submitInputAnswer: vi.fn(),
    createAgentThread: vi.fn(),
    ...overrides,
  } as unknown as HandlerContext;

  registerIpcHandlers(ipcMain, ctx);

  return {
    ctx,
    invoke(channel: string, payload: unknown = {}) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`missing listener: ${channel}`);
      return listener({}, payload);
    },
  };
}

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns a generic error when handler implementations throw raw errors", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.auth.signOut).mockRejectedValue(
      new Error("EACCES: permission denied, unlink '/home/user/.matrix/credential.json'"),
    );

    await expect(harness.invoke("auth:sign-out")).rejects.toThrow("internal error");
    await expect(harness.invoke("auth:sign-out")).rejects.not.toThrow("/home/user");
    expect(console.warn).toHaveBeenCalledWith(
      "[ipc] handler for auth:sign-out failed:",
      "EACCES: permission denied, unlink '/home/user/.matrix/credential.json'",
    );
  });

  it("keeps malformed requests generic", async () => {
    const harness = makeHarness();

    await expect(harness.invoke("shell:open-external", { url: "file:///tmp/secret" })).rejects.toThrow(
      "invalid request",
    );
  });

  it("returns the public embed unavailable error when embed open fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.embeds.open).mockRejectedValue(new Error("native view unavailable"));

    await expect(
      harness.invoke("embed:open", {
        kind: "app",
        slug: "workspace",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      }),
    ).rejects.toThrow("embed unavailable");
  });

  it("returns a failed retry-auth result when embed retry throws", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ctx.embeds.retryAuth).mockRejectedValue(new Error("handoff unavailable"));

    await expect(harness.invoke("embed:retry-auth", { embedId: "embed-1" })).resolves.toEqual({
      ok: false,
    });
    expect(console.warn).toHaveBeenCalledWith("[ipc] embed:retry-auth failed:", "handoff unavailable");
  });

  it("reports the live updater status from the handler context", async () => {
    const harness = makeHarness({ getUpdateStatus: vi.fn(() => "ready") });

    await expect(harness.invoke("update:check")).resolves.toEqual({ status: "ready" });
  });

  it("returns the runtime summary through a strict trusted-core IPC channel", async () => {
    const summary = {
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
      ],
      providers: [],
      projects: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      activeThreads: {
        items: [],
        hasMore: false,
        limit: 20,
      },
      terminalSessions: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      recentActivity: {
        items: [],
        limit: 20,
        hasMore: false,
      },
      limits: {
        maxPromptBytes: 16384,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 8192,
        maxListItems: 20,
      },
      serverTime: "2026-07-06T00:00:00.000Z",
    };
    const fetchRuntimeSummary = vi.fn().mockResolvedValue(summary);
    const harness = makeHarness({ fetchRuntimeSummary } as Partial<HandlerContext>);

    const result = await harness.invoke("runtime:get-summary");
    expect(result).toMatchObject(summary);
    expect(result).toMatchObject({
      attentionThreads: { items: [], hasMore: false, limit: 20 },
      previewSessions: { items: [], hasMore: false, limit: 50 },
    });
    expect(fetchRuntimeSummary).toHaveBeenCalledWith();
  });

  it("maps runtime summary failures to a generic IPC error", async () => {
    const fetchRuntimeSummary = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:4000"));
    const harness = makeHarness({ fetchRuntimeSummary } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-summary")).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-summary")).rejects.not.toThrow("10.0.0.5");
  });

  it("returns coding agent review summaries through a strict trusted-core IPC channel", async () => {
    const reviews = {
      items: [
        {
          id: "rev_desktop_1",
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          status: "reviewing",
          pullRequestNumber: 757,
          round: 1,
          maxRounds: 3,
          reviewer: "codex",
          implementer: "claude",
          findings: { total: 1, high: 0, medium: 1, low: 0 },
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    };
    const fetchReviewSummaries = vi.fn().mockResolvedValue(reviews);
    const harness = makeHarness({ fetchReviewSummaries } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-reviews")).resolves.toEqual(reviews);
    await expect(harness.invoke("runtime:get-reviews", { cursor: "rev_desktop_1" })).resolves.toEqual(reviews);
    expect(fetchReviewSummaries).toHaveBeenNthCalledWith(1, {});
    expect(fetchReviewSummaries).toHaveBeenNthCalledWith(2, { cursor: "rev_desktop_1" });
  });

  it("maps review summary failures to a generic IPC error", async () => {
    const fetchReviewSummaries = vi
      .fn()
      .mockRejectedValue(new Error("Postgres failed at /home/matrix/home"));
    const harness = makeHarness({ fetchReviewSummaries } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-reviews")).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-reviews")).rejects.not.toThrow("/home/matrix");
  });

  it("returns a coding agent review snapshot through a strict trusted-core IPC channel", async () => {
    const snapshot = {
      review: {
        id: "rev_desktop_1",
        projectId: "matrix-os",
        worktreeId: "wt_abc123def456",
        status: "reviewing",
        pullRequestNumber: 757,
        round: 1,
        maxRounds: 3,
        reviewer: "codex",
        implementer: "claude",
        findings: { total: 1, high: 1, medium: 0, low: 0 },
        updatedAt: "2026-07-06T00:00:00.000Z",
      },
      files: {
        items: [
          {
            path: "packages/gateway/src/coding-agents/routes.ts",
            status: "modified",
            additions: 0,
            deletions: 0,
            partial: true,
            hunks: [],
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
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    const fetchReviewSnapshot = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ fetchReviewSnapshot } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-review-snapshot", { reviewId: "rev_desktop_1" })).resolves.toEqual(snapshot);
    expect(fetchReviewSnapshot).toHaveBeenCalledWith({ reviewId: "rev_desktop_1" });
  });

  it("maps review snapshot failures to a generic IPC error", async () => {
    const fetchReviewSnapshot = vi
      .fn()
      .mockRejectedValue(new Error("Postgres failed at /home/matrix/home with token secret"));
    const harness = makeHarness({ fetchReviewSnapshot } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-review-snapshot", { reviewId: "rev_desktop_1" })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-review-snapshot", { reviewId: "rev_desktop_1" })).rejects.not.toThrow("/home/matrix");
  });

  it("returns coding agent file content through a strict trusted-core IPC channel", async () => {
    const file = {
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
    const fetchFileContent = vi.fn().mockResolvedValue(file);
    const harness = makeHarness({ fetchFileContent } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    })).resolves.toEqual(file);
    expect(fetchFileContent).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    });
  });

  it("maps file content failures to a generic IPC error", async () => {
    const fetchFileContent = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: /home/matrix/home/projects/private token"));
    const harness = makeHarness({ fetchFileContent } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    })).rejects.not.toThrow("/home/matrix");
  });

  it("returns a coding agent thread snapshot through a strict trusted-core IPC channel", async () => {
    const snapshot = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "waiting_for_approval",
        attention: "approval_required",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:01:00.000Z",
      },
      events: {
        items: [
          {
            type: "approval.requested",
            eventId: "evt_approval_1",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:01:00.000Z",
            approval: {
              approvalId: "appr_desktop_1",
              threadId: "thread_desktop_1",
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
    const fetchThreadSnapshot = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ fetchThreadSnapshot } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-thread-snapshot", { threadId: "thread_desktop_1" })).resolves.toEqual(snapshot);
    expect(fetchThreadSnapshot).toHaveBeenCalledWith({ threadId: "thread_desktop_1" });
  });

  it("maps thread snapshot failures to a generic IPC error", async () => {
    const fetchThreadSnapshot = vi
      .fn()
      .mockRejectedValue(new Error("provider failed at /home/matrix/home with token secret"));
    const harness = makeHarness({ fetchThreadSnapshot } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-thread-snapshot", { threadId: "thread_desktop_1" })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-thread-snapshot", { threadId: "thread_desktop_1" })).rejects.not.toThrow("/home/matrix");
  });

  it("submits approval decisions through trusted-core IPC without exposing credentials", async () => {
    const snapshot = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
      events: {
        items: [
          {
            type: "approval.resolved",
            eventId: "evt_approval_2",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:02:00.000Z",
            approvalId: "appr_desktop_1",
            decision: "approve",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };
    const submitApprovalDecision = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ submitApprovalDecision } as Partial<HandlerContext>);
    const request = {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      decision: "approve",
      correlationId: "corr_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:submit-approval-decision", request)).resolves.toEqual(snapshot);
    expect(submitApprovalDecision).toHaveBeenCalledWith(request);
    await expect(harness.invoke("runtime:submit-approval-decision", {
      ...request,
      providerToken: "secret",
    })).rejects.toThrow("invalid request");
  });

  it("maps approval decision failures to a generic IPC error", async () => {
    const submitApprovalDecision = vi
      .fn()
      .mockRejectedValue(new Error("provider approval failed at /home/matrix/home with token secret"));
    const harness = makeHarness({ submitApprovalDecision } as Partial<HandlerContext>);
    const request = {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      decision: "approve",
      correlationId: "corr_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:submit-approval-decision", request)).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:submit-approval-decision", request)).rejects.not.toThrow("/home/matrix");
  });

  it("submits input answers through trusted-core IPC without exposing credentials", async () => {
    const snapshot = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Fix desktop notifications",
        status: "running",
        attention: "none",
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      events: {
        items: [
          {
            type: "user_input.answered",
            eventId: "evt_input_2",
            threadId: "thread_desktop_1",
            occurredAt: "2026-07-06T00:03:00.000Z",
            requestId: "req_input_desktop_1",
            correlationId: "corr_input_desktop_1",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    };
    const submitInputAnswer = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ submitInputAnswer } as Partial<HandlerContext>);
    const request = {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      answer: "Run the focused desktop test.",
      correlationId: "corr_input_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:submit-input-answer", request)).resolves.toEqual(snapshot);
    expect(submitInputAnswer).toHaveBeenCalledWith(request);
    await expect(harness.invoke("runtime:submit-input-answer", {
      ...request,
      providerToken: "secret",
    })).rejects.toThrow("invalid request");
  });

  it("maps input answer failures to a generic IPC error", async () => {
    const submitInputAnswer = vi
      .fn()
      .mockRejectedValue(new Error("provider input failed at /home/matrix/home with token secret"));
    const harness = makeHarness({ submitInputAnswer } as Partial<HandlerContext>);
    const request = {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      answer: "Run the focused desktop test.",
      correlationId: "corr_input_desktop_1",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:submit-input-answer", request)).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:submit-input-answer", request)).rejects.not.toThrow("/home/matrix");
  });

  it("creates agent threads through trusted-core IPC without exposing credentials", async () => {
    const snapshot = {
      thread: {
        id: "thread_desktop_1",
        providerId: "codex",
        title: "Summarize the failing checks",
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
    const createAgentThread = vi.fn().mockResolvedValue(snapshot);
    const harness = makeHarness({ createAgentThread } as Partial<HandlerContext>);
    const request = {
      providerId: "codex",
      prompt: "Summarize the failing checks",
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      clientRequestId: "req_desktop_1",
    };

    await expect(harness.invoke("runtime:create-thread", request)).resolves.toEqual(snapshot);
    expect(createAgentThread).toHaveBeenCalledWith(request);
  });

  it("maps agent thread create failures to a generic IPC error", async () => {
    const createAgentThread = vi
      .fn()
      .mockRejectedValue(new Error("provider failed on /home/matrix/workspace with token secret"));
    const harness = makeHarness({ createAgentThread } as Partial<HandlerContext>);

    await expect(
      harness.invoke("runtime:create-thread", {
        providerId: "codex",
        prompt: "Summarize the failing checks",
        clientRequestId: "req_desktop_1",
      }),
    ).rejects.toThrow("internal error");
    await expect(
      harness.invoke("runtime:create-thread", {
        providerId: "codex",
        prompt: "Summarize the failing checks",
        clientRequestId: "req_desktop_1",
      }),
    ).rejects.not.toThrow("/home/matrix");
  });
});
