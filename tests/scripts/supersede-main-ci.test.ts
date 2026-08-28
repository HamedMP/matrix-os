import { describe, expect, it, vi } from "vitest";
import {
  cancelMainCiRun,
  cancelSupersededMainCiRuns,
  findSupersededMainCiRuns,
  listActiveMainCiRuns,
  supersedeMainCi,
} from "../../scripts/ci/supersede-main-ci.mjs";

describe("main CI supersession", () => {
  it("cancels only active older main-push runs that are ancestors of the full successor", async () => {
    const runs = [
      { id: 1, headSha: "running-ancestor", event: "push", status: "in_progress" },
      { id: 2, headSha: "queued-ancestor", event: "push", status: "queued" },
      { id: 3, headSha: "same-head", event: "push", status: "queued" },
      { id: 4, headSha: "newer-head", event: "push", status: "queued" },
      { id: 5, headSha: "completed", event: "push", status: "completed" },
      { id: 6, headSha: "pr-head", event: "pull_request", status: "in_progress" },
    ];

    await expect(
      findSupersededMainCiRuns(runs, "same-head", {
        isAncestor: async (candidate) => candidate.endsWith("ancestor"),
      }),
    ).resolves.toEqual([
      { id: 1, headSha: "running-ancestor" },
      { id: 2, headSha: "queued-ancestor" },
    ]);
  });

  it("treats a completion race as safe while canceling every selected run", async () => {
    const cancelRun = vi.fn()
      .mockResolvedValueOnce("cancelled")
      .mockResolvedValueOnce("already_completed");

    await expect(
      cancelSupersededMainCiRuns(
        [
          { id: 10, headSha: "first" },
          { id: 11, headSha: "second" },
        ],
        { cancelRun },
      ),
    ).resolves.toEqual({ cancelled: 1, alreadyCompleted: 1 });
    expect(cancelRun).toHaveBeenNthCalledWith(1, 10);
    expect(cancelRun).toHaveBeenNthCalledWith(2, 11);
  });

  it("fails closed unless the full successor can load, compare, and cancel the queue", async () => {
    const cancelRun = vi.fn(async () => "cancelled" as const);

    await expect(
      supersedeMainCi(
        { repository: "HamedMP/matrix-os", targetSha: "target", token: "token" },
        {
          listRuns: async () => [
            { id: 7, headSha: "ancestor", event: "push", status: "in_progress" },
          ],
          isAncestor: async () => true,
          cancelRun,
        },
      ),
    ).resolves.toEqual({ selected: 1, cancelled: 1, alreadyCompleted: 0 });
    expect(cancelRun).toHaveBeenCalledWith(7);
  });

  it("uses bounded GitHub requests and accepts completion races from the cancel endpoint", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        workflow_runs: [
          {
            id: 99,
            head_sha: "a".repeat(40),
            event: "push",
            status: "queued",
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    const config = {
      repository: "HamedMP/matrix-os",
      token: "test-token",
      fetchImpl,
    };

    await expect(listActiveMainCiRuns(config)).resolves.toEqual([
      { id: 99, headSha: "a".repeat(40), event: "push", status: "queued" },
    ]);
    await expect(cancelMainCiRun(99, config)).resolves.toBe("already_completed");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("actions/workflows/ci.yml/runs");
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });
});
