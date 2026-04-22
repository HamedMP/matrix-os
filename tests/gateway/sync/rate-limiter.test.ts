import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createSyncRateLimiter,
  type SyncRateLimiter,
} from "../../../packages/gateway/src/sync/rate-limiter.js";

describe("SyncRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 5, windowMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      expect(limiter.check("user1")).toBe(true);
    }
  });

  it("blocks requests over the limit", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 3, windowMs: 60_000 });

    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(false);
  });

  it("tracks users independently", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 2, windowMs: 60_000 });

    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(false);

    // user2 should still be allowed
    expect(limiter.check("user2")).toBe(true);
    expect(limiter.check("user2")).toBe(true);
  });

  it("resets after the window expires", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 2, windowMs: 60_000 });

    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(true);
    expect(limiter.check("user1")).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(61_000);

    expect(limiter.check("user1")).toBe(true);
  });

  it("uses sliding window (old timestamps expire)", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 3, windowMs: 60_000 });

    expect(limiter.check("user1")).toBe(true); // t=0
    vi.advanceTimersByTime(20_000);
    expect(limiter.check("user1")).toBe(true); // t=20s
    vi.advanceTimersByTime(20_000);
    expect(limiter.check("user1")).toBe(true); // t=40s
    expect(limiter.check("user1")).toBe(false); // t=40s, limit hit

    // Advance 25s more (t=65s) -- first request at t=0 is now >60s old
    vi.advanceTimersByTime(25_000);
    expect(limiter.check("user1")).toBe(true); // first request expired
  });

  it("enforces bounded user map (max 10K users)", () => {
    const limiter = createSyncRateLimiter({ maxRequests: 100, windowMs: 60_000, maxUsers: 100 });

    // Fill up 100 users
    for (let i = 0; i < 100; i++) {
      limiter.check(`user-${i}`);
    }

    // Adding user 101 should succeed (oldest evicted)
    expect(limiter.check("user-100")).toBe(true);
  });

  it("defaults to 100 req/min", () => {
    const limiter = createSyncRateLimiter();

    for (let i = 0; i < 100; i++) {
      expect(limiter.check("user1")).toBe(true);
    }
    expect(limiter.check("user1")).toBe(false);
  });
});
