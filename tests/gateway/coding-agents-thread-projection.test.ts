import { describe, expect, it, vi } from "vitest";
import {
  deriveThreadProjectionChanges,
  publishThreadProjectionChanges,
} from "../../packages/gateway/src/coding-agents/thread-projection.js";

const now = "2026-07-10T15:00:00.000Z";

function thread(id: string, projectId?: string) {
  return {
    id,
    providerId: "codex",
    title: "Coding agent run",
    status: "running" as const,
    attention: "none" as const,
    projectId,
    createdAt: now,
    updatedAt: now,
  };
}

describe("coding agent thread projection changes", () => {
  it("derives created, changed, and removed public projections without unchanged noise", () => {
    const unchanged = thread("thread_unchanged", "matrix-os");
    const changedBefore = thread("thread_changed", "matrix-os");
    const removed = thread("thread_removed", "matrix-os");
    const changedAfter = { ...changedBefore, status: "completed" as const };
    const created = thread("thread_created", "matrix-os");

    expect(deriveThreadProjectionChanges({
      previous: [unchanged, changedBefore, removed],
      next: [unchanged, changedAfter, created],
      toSummary: (value) => value,
    })).toEqual([
      { type: "updated", thread: changedAfter },
      { type: "created", thread: created },
      { type: "removed", thread: removed },
    ]);
  });

  it("publishes project-scoped changes sequentially and isolates failures", async () => {
    const failure = new Error("event store unavailable");
    const publisher = vi.fn(async (change: { thread: { id: string } }) => {
      if (change.thread.id === "thread_failed") throw failure;
    });
    const logFailure = vi.fn();

    await publishThreadProjectionChanges({
      changes: [
        { type: "updated", thread: thread("thread_unassigned") },
        { type: "updated", thread: thread("thread_failed", "matrix-os") },
        { type: "updated", thread: thread("thread_published", "matrix-os") },
      ],
      publisher,
      logFailure,
    });

    expect(publisher.mock.calls.map(([change]) => change.thread.id)).toEqual([
      "thread_failed",
      "thread_published",
    ]);
    expect(logFailure).toHaveBeenCalledWith(failure);
  });
});
