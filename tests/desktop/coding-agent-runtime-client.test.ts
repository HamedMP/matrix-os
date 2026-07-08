import { describe, expect, it, vi } from "vitest";
import {
  fetchCodingAgentReviewSnapshot,
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

describe("coding agent desktop runtime client", () => {
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
