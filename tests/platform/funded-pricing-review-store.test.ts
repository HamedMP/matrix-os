import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FundedAiPricingReviewSnapshotSchema, type FundedAiPricingReview } from "@matrix-os/contracts";
import { createAiFundedRelayRoutes } from "../../packages/platform/src/ai-funded-policy-routes.js";
import type { AiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createFundedPricingReviewStore } from "../../packages/platform/src/funded-pricing-review-store.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./native-platform-db-test-helper.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const review: FundedAiPricingReview = {
  modelId: "anthropic/claude-sonnet-5",
  version: "anthropic-2026-08-31-standard",
  reviewedAt: now.toISOString(),
  validThrough: "2026-12-11T12:00:00.000Z",
  sourceDigest: "a".repeat(64),
  blockedAt: null,
};

describe("funded pricing registry", () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("accepts a bounded snapshot and rejects duplicates or extended review windows", () => {
    const snapshot = { contractVersion: 1, reviews: [review] };
    expect(FundedAiPricingReviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(FundedAiPricingReviewSnapshotSchema.safeParse({ ...snapshot, reviews: [review, review] }).success).toBe(false);
    expect(FundedAiPricingReviewSnapshotSchema.safeParse({
      ...snapshot, reviews: [{ ...review, validThrough: "2026-12-31T12:00:00.000Z" }],
    }).success).toBe(false);
  });

  it("serves the review snapshot only to the authenticated Relay", async () => {
    let reads = 0;
    const token = "p".repeat(48);
    const app = createAiFundedRelayRoutes({
      relayControlToken: token,
      repository: {} as AiFundedPolicyRepository,
      listPricingReviews: async () => { reads += 1; return [review]; },
    });
    const denied = await app.request("/pricing-reviews");
    expect(denied.status).toBe(401);
    expect(reads).toBe(0);
    const granted = await app.request("/pricing-reviews", { headers: { authorization: `Bearer ${token}` } });
    expect(granted.status).toBe(200);
    expect(granted.headers.get("cache-control")).toBe("no-store, private");
    expect(await granted.json()).toEqual({ contractVersion: 1, reviews: [review] });
    expect(reads).toBe(1);
  });

  it("accepts only authenticated recent route failures", async () => {
    const calls: string[] = [];
    const token = "p".repeat(48);
    const app = createAiFundedRelayRoutes({
      relayControlToken: token,
      repository: {} as AiFundedPolicyRepository,
      invalidatePricingRoute: async (modelId) => { calls.push(modelId); },
    });
    const send = (observedAt: string, authorized = true) => app.request("/pricing-route-failure", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ modelId: review.modelId, version: review.version, observedAt }),
    });
    expect((await send(new Date().toISOString(), false)).status).toBe(401);
    expect((await send(now.toISOString())).status).toBe(400);
    expect((await send(new Date().toISOString())).status).toBe(204);
    expect(calls).toEqual([review.modelId]);
  });

  it("admits only one writer and fences stale leases and unsupported versions", async () => {
    const first = createFundedPricingReviewStore(db, () => now);
    const second = createFundedPricingReviewStore(db, () => now);
    const claims = await Promise.all([first.claim("review", now), second.claim("review", now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const lease = claims.find((value): value is string => value !== null)!;
    expect(await first.save(review, "unowned")).toBe(false);
    expect(await first.save({ ...review, version: "unsupported-version" }, lease)).toBe(false);
    expect(await first.save(review, lease)).toBe(true);
    expect(await second.list()).toEqual([review]);
    await second.finish("review", lease, now, true);
    expect(await first.claim("review", now)).toBeNull();
    expect(await first.save({ ...review, blockedAt: now.toISOString() }, lease)).toBe(false);
    expect(await first.claim("watchdog", now)).not.toBeNull();
    expect(await second.watchdogStatus()).toEqual({ firstWatchdogClaim: now, lastSuccessfulReview: now });
  });

  it("preserves the first watchdog claim across process restarts and claims", async () => {
    const first = createFundedPricingReviewStore(db, () => now);
    const lease = (await first.claim("watchdog", now))!;
    await first.finish("watchdog", lease, now, true);
    const later = new Date(now.getTime() + 45 * 60_000);
    const restarted = createFundedPricingReviewStore(db, () => later);
    expect(await restarted.claim("watchdog", later)).not.toBeNull();
    expect(await restarted.watchdogStatus()).toEqual({ firstWatchdogClaim: now, lastSuccessfulReview: null });
  });

  it("excludes expired and blocked reviews without touching eligible siblings", async () => {
    const store = createFundedPricingReviewStore(db, () => now);
    const lease = (await store.claim("review", now))!;
    expect(await store.save(review, lease)).toBe(true);
    expect(await store.readCurrent(review.modelId, now)).toEqual({ version: review.version, validThrough: review.validThrough });
    expect(await store.readCurrent(review.modelId, new Date(review.validThrough))).toBeNull();
    const blocked = { ...review, blockedAt: now.toISOString(), sourceDigest: "b".repeat(64) };
    expect(await store.save(blocked, lease)).toBe(true);
    expect(await store.readCurrent(review.modelId, now)).toBeNull();
    expect(await store.save(review, lease)).toBe(false);
    expect(await store.save(blocked, lease)).toBe(true);
    const history = await sql<{ source_digest: string }>`
      SELECT source_digest FROM ai_funded_pricing_review_history ORDER BY source_digest
    `.execute(db.executor);
    expect(history.rows).toEqual([{ source_digest: review.sourceDigest }, { source_digest: blocked.sourceDigest }]);
  });

  it("shares one pending snapshot and does not queue more database work after it times out", async () => {
    const store = createFundedPricingReviewStore(db, () => now);
    const lease = (await store.claim("review", now))!;
    expect(await store.save(review, lease)).toBe(true);
    const allowConnection = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const originalTransaction = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async (work) => {
      try {
        await allowConnection.promise;
        return await originalTransaction(work);
      } finally {
        finished.resolve();
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reads = Promise.allSettled([store.list(), store.readCurrent(review.modelId)]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(transaction).toHaveBeenCalledOnce();
      expect(await reads).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      await expect(store.list()).rejects.toThrow("Pricing review snapshot unavailable");
      expect(transaction).toHaveBeenCalledOnce();
      allowConnection.resolve();
      await finished.promise;
      await vi.advanceTimersByTimeAsync(0);
      await expect(store.list()).resolves.toEqual([review]);
    } finally {
      allowConnection.resolve();
      vi.useRealTimers();
      transaction.mockRestore();
    }
  });
});
