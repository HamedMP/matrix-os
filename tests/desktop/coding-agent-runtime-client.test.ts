import { describe, expect, it, vi } from "vitest";
import {
  createCodingAgentSourcePullRequest,
  fetchCodingAgentFileContent,
  fetchCodingAgentThreadSnapshot,
  fetchCodingAgentReviewSnapshot,
  prepareCodingAgentSourceCommit,
  saveCodingAgentFileContent,
  submitCodingAgentApprovalDecision,
  submitCodingAgentInputAnswer,
} from "../../desktop/src/main/coding-agents/runtime-summary-client";
import type { AuthService } from "../../desktop/src/main/auth/auth-service";

function auth(): AuthService {
  return {
    getToken: () => "desktop-token",
    getGatewayOrigin: () => "https://runtime.test",
    getStatus: () => ({
      signedIn: true,
      handle: "operator",
      runtimeSlot: "primary",
      platformHost: "https://runtime.test",
    }),
  } as unknown as AuthService;
}

function snapshotBody() {
  return {
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
          findings: [{
            id: "HIGH-1",
            severity: "high",
            line: 42,
            summary: "Validate ownership before returning snapshots.",
          }],
        },
      ],
      hasMore: false,
      limit: 100,
    },
    partial: true,
    safeNotice: "Diff content is not available yet. Showing bounded review findings.",
    updatedAt: "2026-07-06T00:00:00.000Z",
  };
}

function fileReadBody() {
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

function sourceCommitBody() {
  return {
    status: "committed",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    branch: "feature/review-fix",
    changedFileCount: 1,
    safeMessage: "Changes were committed.",
  };
}

function sourcePullRequestBody() {
  return {
    status: "created",
    number: 808,
    url: "https://github.com/HamedMP/matrix-os/pull/808",
    headBranch: "feature/review-fix",
    baseBranch: "main",
    safeMessage: "Pull request is ready for review.",
  };
}

function threadSnapshotBody() {
  return {
    thread: {
      id: "thread_desktop_1",
      providerId: "codex",
      title: "Fix desktop notifications",
      status: "waiting_for_approval",
      attention: "approval_required",
      terminalSessionId: "matrix-abc1234",
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
}

describe("coding agent desktop runtime client", () => {
  it("fetches thread snapshots with bearer auth and validates safe output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(threadSnapshotBody()), { status: 200 }));

    const snapshot = await fetchCodingAgentThreadSnapshot(auth(), { threadId: "thread_desktop_1" }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/threads/thread_desktop_1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshot.thread.id).toBe("thread_desktop_1");
    expect(snapshot.events.items[0]?.type).toBe("approval.requested");
  });

  it("rejects unsafe or malformed thread snapshot responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...threadSnapshotBody(),
      thread: {
        ...threadSnapshotBody().thread,
        accessToken: "secret",
      },
    }), { status: 200 }));

    await expect(fetchCodingAgentThreadSnapshot(auth(), { threadId: "thread_desktop_1" }, fetchFn)).rejects.toThrow("thread state unavailable");
    await expect(fetchCodingAgentThreadSnapshot(auth(), { threadId: "thread_desktop_1" }, fetchFn)).rejects.not.toThrow("secret");
  });

  it("submits approval decisions with bearer auth and validates the returned thread snapshot", async () => {
    const resolved = {
      ...threadSnapshotBody(),
      thread: {
        ...threadSnapshotBody().thread,
        status: "running",
        attention: "none",
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
      events: {
        ...threadSnapshotBody().events,
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
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved), { status: 200 }));

    const snapshot = await submitCodingAgentApprovalDecision(auth(), {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      request: {
        decision: "approve",
        correlationId: "corr_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/threads/thread_desktop_1/approvals/appr_desktop_1/decision",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          decision: "approve",
          correlationId: "corr_desktop_1",
          clientRequestId: "req_desktop_1",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshot.thread.status).toBe("running");
    expect(snapshot.events.items[0]?.type).toBe("approval.resolved");
  });

  it("rejects unsafe approval decision responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...threadSnapshotBody(),
      accessToken: "secret",
    }), { status: 200 }));

    await expect(submitCodingAgentApprovalDecision(auth(), {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      request: {
        decision: "approve",
        correlationId: "corr_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn)).rejects.toThrow("approval unavailable");
    await expect(submitCodingAgentApprovalDecision(auth(), {
      threadId: "thread_desktop_1",
      approvalId: "appr_desktop_1",
      request: {
        decision: "approve",
        correlationId: "corr_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn)).rejects.not.toThrow("secret");
  });

  it("submits input answers with bearer auth and validates the returned thread snapshot", async () => {
    const answered = {
      ...threadSnapshotBody(),
      thread: {
        ...threadSnapshotBody().thread,
        status: "running",
        attention: "none",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
      events: {
        ...threadSnapshotBody().events,
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
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(answered), { status: 200 }));

    const snapshot = await submitCodingAgentInputAnswer(auth(), {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      request: {
        answer: "Run the focused desktop test.",
        correlationId: "corr_input_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/threads/thread_desktop_1/inputs/req_input_desktop_1/answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          answer: "Run the focused desktop test.",
          correlationId: "corr_input_desktop_1",
          clientRequestId: "req_desktop_1",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshot.thread.status).toBe("running");
    expect(snapshot.events.items[0]?.type).toBe("user_input.answered");
  });

  it("rejects unsafe input answer responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...threadSnapshotBody(),
      accessToken: "secret",
    }), { status: 200 }));

    await expect(submitCodingAgentInputAnswer(auth(), {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      request: {
        answer: "Run the focused desktop test.",
        correlationId: "corr_input_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn)).rejects.toThrow("input unavailable");
    await expect(submitCodingAgentInputAnswer(auth(), {
      threadId: "thread_desktop_1",
      inputRequestId: "req_input_desktop_1",
      request: {
        answer: "Run the focused desktop test.",
        correlationId: "corr_input_desktop_1",
        clientRequestId: "req_desktop_1",
      },
    }, fetchFn)).rejects.not.toThrow("secret");
  });

  it("fetches review snapshots with bearer auth and validates safe output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshotBody()), { status: 200 }));

    const snapshot = await fetchCodingAgentReviewSnapshot(auth(), { reviewId: "rev_desktop_1" }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/reviews/rev_desktop_1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(snapshot.files.items[0]?.path).toBe("packages/gateway/src/coding-agents/routes.ts");
  });

  it("fetches bounded file content with bearer auth and validates safe output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(fileReadBody()), { status: 200 }));

    const file = await fetchCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/files/read?projectId=matrix-os&worktreeId=wt_abc123def456&path=packages%2Fgateway%2Fsrc%2Fcoding-agents%2Froutes.ts",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(file.content).toBe("export const safeRoute = true;\n");
  });

  it("saves bounded file content with bearer auth and validates safe output", async () => {
    const responseBody = {
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
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 }));

    const saved = await saveCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/files/write",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          path: "packages/gateway/src/coding-agents/routes.ts",
          content: "export const safeRoute = false;\n",
          encoding: "utf8",
          baseEtag: "sha256_desktop_file",
          clientRequestId: "req_desktop_file_save",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(saved.metadata.etag).toBe("sha256_desktop_file_next");
  });

  it("prepares a source-control commit with bearer auth and validates safe output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(sourceCommitBody()), { status: 201 }));

    const commit = await prepareCodingAgentSourceCommit(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/source-control/prepare-commit",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          message: "fix: update reviewed files",
          paths: ["packages/gateway/src/coding-agents/routes.ts"],
          clientRequestId: "req_desktop_prepare_commit",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(commit.commitSha).toBe(sourceCommitBody().commitSha);
    expect(JSON.stringify(commit)).not.toMatch(/token|bearer|secret|\/home\/matrix/i);
  });

  it("creates a source-control pull request with bearer auth and validates safe output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(sourcePullRequestBody()), { status: 201 }));

    const pullRequest = await createCodingAgentSourcePullRequest(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    }, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/coding-agents/source-control/pull-requests",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          projectId: "matrix-os",
          worktreeId: "wt_abc123def456",
          title: "fix: apply review updates for PR #758",
          body: "Review updates are ready.",
          clientRequestId: "req_desktop_create_pr",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(pullRequest.url).toBe(sourcePullRequestBody().url);
    expect(JSON.stringify(pullRequest)).not.toMatch(/token|bearer|secret|\/home\/matrix/i);
  });

  it("rejects unsafe or malformed review snapshot responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...snapshotBody(),
      files: {
        ...snapshotBody().files,
        items: [{ ...snapshotBody().files.items[0], path: "/home/matrix/private/secret.ts" }],
      },
    }), { status: 200 }));

    await expect(fetchCodingAgentReviewSnapshot(auth(), { reviewId: "rev_desktop_1" }, fetchFn)).rejects.toThrow("review state unavailable");
    await expect(fetchCodingAgentReviewSnapshot(auth(), { reviewId: "rev_desktop_1" }, fetchFn)).rejects.not.toThrow("/home/matrix");
  });

  it("rejects unsafe file content responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...fileReadBody(),
      metadata: {
        ...fileReadBody().metadata,
        path: "/home/matrix/private/secret.ts",
      },
    }), { status: 200 }));

    await expect(fetchCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    }, fetchFn)).rejects.toThrow("file content unavailable");
    await expect(fetchCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
    }, fetchFn)).rejects.not.toThrow("/home/matrix");
  });

  it("rejects unsafe file save responses with a generic error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      metadata: {
        path: "/home/matrix/private/secret.ts",
        kind: "file",
        sizeBytes: 38,
        etag: "sha256_desktop_file_next",
        updatedAt: "2026-07-06T00:04:00.000Z",
      },
      encoding: "utf8",
      writtenBytes: 38,
    }), { status: 200 }));

    await expect(saveCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    }, fetchFn)).rejects.toThrow("file save unavailable");
    await expect(saveCodingAgentFileContent(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      path: "packages/gateway/src/coding-agents/routes.ts",
      content: "export const safeRoute = false;\n",
      encoding: "utf8",
      baseEtag: "sha256_desktop_file",
      clientRequestId: "req_desktop_file_save",
    }, fetchFn)).rejects.not.toThrow("/home/matrix");
  });

  it("rejects unsafe source-control commit requests and responses with generic errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...sourceCommitBody(),
      branch: "/home/matrix/private",
    }), { status: 201 }));

    await expect(prepareCodingAgentSourceCommit(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["packages/gateway/src/coding-agents/routes.ts"],
      clientRequestId: "req_desktop_prepare_commit",
    }, fetchFn)).rejects.toThrow("source commit unavailable");
    await expect(prepareCodingAgentSourceCommit(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      message: "fix: update reviewed files",
      paths: ["../system/config.json"],
      clientRequestId: "req_desktop_prepare_commit",
    }, fetchFn)).rejects.toThrow("source commit unavailable");
  });

  it("rejects unsafe source-control pull request requests and responses with generic errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...sourcePullRequestBody(),
      url: "file:///home/matrix/private/secret",
    }), { status: 201 }));

    await expect(createCodingAgentSourcePullRequest(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "fix: apply review updates for PR #758",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    }, fetchFn)).rejects.toThrow("pull request unavailable");
    await expect(createCodingAgentSourcePullRequest(auth(), {
      projectId: "matrix-os",
      worktreeId: "wt_abc123def456",
      title: "",
      body: "Review updates are ready.",
      clientRequestId: "req_desktop_create_pr",
    }, fetchFn)).rejects.toThrow("pull request unavailable");
  });
});
