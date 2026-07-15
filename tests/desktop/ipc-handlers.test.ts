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
    fetchProjectWorkspace: vi.fn(),
    fetchReviewSummaries: vi.fn(),
    fetchReviewSnapshot: vi.fn(),
    fetchFileBrowse: vi.fn(),
    fetchFileSearch: vi.fn(),
    fetchFileContent: vi.fn(),
    saveFileContent: vi.fn(),
    prepareSourceCommit: vi.fn(),
    createSourcePullRequest: vi.fn(),
    fetchThreadSnapshot: vi.fn(),
    subscribeThreadEvents: vi.fn(),
    unsubscribeThreadEvents: vi.fn(),
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

  it("DT-001 returns a project workspace through strict trusted-core IPC", async () => {
    const workspace = {
      project: {
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 1,
        threadCount: 0,
        attentionCount: 0,
      },
      tasks: { items: [], hasMore: false, limit: 100 },
      projectThreads: { items: [], hasMore: false, limit: 100 },
      taskThreads: { items: [], hasMore: false, limit: 100 },
      updatedAt: "2026-07-10T12:00:00.000Z",
    };
    const fetchProjectWorkspace = vi.fn().mockResolvedValue(workspace);
    const harness = makeHarness({ fetchProjectWorkspace } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-project-workspace", {
      projectId: "matrix-os",
    })).resolves.toEqual(workspace);
    expect(fetchProjectWorkspace).toHaveBeenCalledWith({ projectId: "matrix-os" });
    await expect(harness.invoke("runtime:get-project-workspace", {
      projectId: "matrix-os",
      bearerToken: "secret",
    })).rejects.toThrow("invalid request");
  });

  it("SEC-003 maps project workspace failures to a generic IPC error", async () => {
    const fetchProjectWorkspace = vi
      .fn()
      .mockRejectedValue(new Error("read failed at /home/matrix/private with token secret"));
    const harness = makeHarness({ fetchProjectWorkspace } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:get-project-workspace", {
      projectId: "matrix-os",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:get-project-workspace", {
      projectId: "matrix-os",
    })).rejects.not.toThrow("/home/matrix");
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

  it("returns coding agent file browse entries through a strict trusted-core IPC channel", async () => {
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
        ],
        hasMore: false,
        limit: 20,
      },
    };
    const fetchFileBrowse = vi.fn().mockResolvedValue(browse);
    const harness = makeHarness({ fetchFileBrowse } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      limit: 20,
    })).resolves.toEqual(browse);
    expect(fetchFileBrowse).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      limit: 20,
    });
  });

  it("maps file browse failures to a generic IPC error", async () => {
    const fetchFileBrowse = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: /home/matrix/home/projects/private token"));
    const harness = makeHarness({ fetchFileBrowse } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
    })).rejects.not.toThrow("/home/matrix");
  });

  it("returns coding agent file search results through a strict trusted-core IPC channel", async () => {
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
    const fetchFileSearch = vi.fn().mockResolvedValue(search);
    const harness = makeHarness({ fetchFileSearch } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:search-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      query: "routes",
      limit: 20,
    })).resolves.toEqual(search);
    expect(fetchFileSearch).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages",
      query: "routes",
      limit: 20,
    });
  });

  it("maps file search failures to a generic IPC error", async () => {
    const fetchFileSearch = vi
      .fn()
      .mockRejectedValue(new Error("search failed in /home/matrix/home/projects/private token"));
    const harness = makeHarness({ fetchFileSearch } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:search-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: "routes",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:search-files", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      query: "routes",
    })).rejects.not.toThrow("/home/matrix");
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

  it("saves coding agent file content through a strict trusted-core IPC channel", async () => {
    const saved = {
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
    const saveFileContent = vi.fn().mockResolvedValue(saved);
    const harness = makeHarness({ saveFileContent } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:save-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    })).resolves.toEqual(saved);
    expect(saveFileContent).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    });
  });

  it("maps file save failures to a generic IPC error", async () => {
    const saveFileContent = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: /home/matrix/home/projects/private token"));
    const harness = makeHarness({ saveFileContent } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:save-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:save-file-content", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    })).rejects.not.toThrow("/home/matrix");
  });

  it("prepares a source-control commit through a strict trusted-core IPC channel", async () => {
    const prepared = {
      status: "committed",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/review-fix",
      changedFileCount: 1,
      safeMessage: "Changes were committed.",
    };
    const prepareSourceCommit = vi.fn().mockResolvedValue(prepared);
    const harness = makeHarness({ prepareSourceCommit } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:prepare-source-commit", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    })).resolves.toEqual(prepared);
    expect(prepareSourceCommit).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    });
  });

  it("maps source-control commit failures to a generic IPC error", async () => {
    const prepareSourceCommit = vi
      .fn()
      .mockRejectedValue(new Error("git failed in /home/matrix/home/projects/private token"));
    const harness = makeHarness({ prepareSourceCommit } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:prepare-source-commit", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:prepare-source-commit", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    })).rejects.not.toThrow("/home/matrix");
  });

  it("creates a source-control pull request through a strict trusted-core IPC channel", async () => {
    const pullRequest = {
      status: "created",
      number: 808,
      url: "https://github.com/HamedMP/matrix-os/pull/808",
      headBranch: "feature/review-fix",
      baseBranch: "main",
      safeMessage: "Pull request is ready for review.",
    };
    const createSourcePullRequest = vi.fn().mockResolvedValue(pullRequest);
    const harness = makeHarness({ createSourcePullRequest } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:create-source-pull-request", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    })).resolves.toEqual(pullRequest);
    expect(createSourcePullRequest).toHaveBeenCalledWith({
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    });
  });

  it("maps source-control pull request failures to a generic IPC error", async () => {
    const createSourcePullRequest = vi
      .fn()
      .mockRejectedValue(new Error("gh failed in /home/matrix/home/projects/private token"));
    const harness = makeHarness({ createSourcePullRequest } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:create-source-pull-request", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    })).rejects.toThrow("internal error");
    await expect(harness.invoke("runtime:create-source-pull-request", {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
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

  it("subscribes and unsubscribes desktop thread streams through trusted-core IPC", async () => {
    const subscribeThreadEvents = vi.fn().mockResolvedValue(undefined);
    const unsubscribeThreadEvents = vi.fn();
    const harness = makeHarness({
      subscribeThreadEvents,
      unsubscribeThreadEvents,
    } as Partial<HandlerContext>);

    await expect(harness.invoke("runtime:subscribe-thread-events", {
      threadId: "thread_desktop_1",
      cursor: "evt_approval_1",
    })).resolves.toEqual({ ok: true });
    await expect(harness.invoke("runtime:unsubscribe-thread-events", {
      threadId: "thread_desktop_1",
    })).resolves.toEqual({ ok: true });

    expect(subscribeThreadEvents).toHaveBeenCalledWith({
      threadId: "thread_desktop_1",
      cursor: "evt_approval_1",
    });
    expect(unsubscribeThreadEvents).toHaveBeenCalledWith({
      threadId: "thread_desktop_1",
    });
    await expect(harness.invoke("runtime:subscribe-thread-events", {
      threadId: "../secret",
    })).rejects.toThrow("invalid request");
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
