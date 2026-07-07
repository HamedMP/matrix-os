import { describe, expect, it, vi } from "vitest";
import {
  fetchCodingAgentThreadSnapshot,
  fetchCodingAgentReviewSnapshot,
  submitCodingAgentApprovalDecision,
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
});
