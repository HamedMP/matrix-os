import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewLoopRecord } from "../../packages/gateway/src/review-loop.js";
import { createReviewStore } from "../../packages/gateway/src/review-store.js";

describe("review-store", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-review-store-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  function record(id = "rev_abc123") {
    return createReviewLoopRecord({
      id,
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      pr: 42,
      reviewer: "claude",
      implementer: "codex",
      maxRounds: 3,
      convergenceGate: "findings_only",
      verificationCommands: [],
      now: () => id === "rev_abc123" ? "2026-04-26T00:00:00.000Z" : "2026-04-26T00:01:00.000Z",
    });
  }

  it("persists review records atomically under system/reviews", async () => {
    const store = createReviewStore({ homePath });

    await expect(store.saveReview(record())).resolves.toEqual({ ok: true });

    const path = join(homePath, "system", "reviews", "rev_abc123.json");
    await expect(stat(path)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(readFile(path, "utf-8")).resolves.toContain('"id": "rev_abc123"');
    await expect(store.getReview("rev_abc123")).resolves.toMatchObject({
      ok: true,
      review: { id: "rev_abc123", status: "queued" },
    });
  });

  it("lists review records sorted by updated time and supports project filters", async () => {
    const store = createReviewStore({ homePath });
    await store.saveReview(record("rev_older"));
    await store.saveReview({ ...record("rev_newer"), projectSlug: "other" });

    await expect(store.listReviews({ limit: 10 })).resolves.toMatchObject({
      ok: true,
      reviews: [
        expect.objectContaining({ id: "rev_newer" }),
        expect.objectContaining({ id: "rev_older" }),
      ],
      nextCursor: null,
    });
    await expect(store.listReviews({ projectSlug: "other", limit: 10 })).resolves.toMatchObject({
      ok: true,
      reviews: [expect.objectContaining({ id: "rev_newer" })],
    });
  });

  it("rejects invalid review identifiers before touching the filesystem", async () => {
    const store = createReviewStore({ homePath });

    await expect(store.getReview("../bad")).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_review_id" },
    });
    await expect(stat(join(homePath, "system"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
