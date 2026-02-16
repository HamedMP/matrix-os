import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimiter,
} from "../../packages/gateway/src/security/rate-limiter.js";

describe("T826: Rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under limit", () => {
    const limiter = createRateLimiter({ maxAttempts: 5, windowMs: 60_000, lockoutMs: 300_000 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("192.168.1.1")).toBe(true);
    }
  });

  it("blocks after maxAttempts within window", () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 300_000 });
    expect(limiter.check("10.0.0.1")).toBe(true);
    expect(limiter.check("10.0.0.1")).toBe(true);
    expect(limiter.check("10.0.0.1")).toBe(true);
    expect(limiter.check("10.0.0.1")).toBe(false);
  });

  it("resets after windowMs", () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 0 });
    expect(limiter.check("10.0.0.1")).toBe(true);
    expect(limiter.check("10.0.0.1")).toBe(true);
    expect(limiter.check("10.0.0.1")).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(limiter.check("10.0.0.1")).toBe(true);
  });

  it("lockout persists for lockoutMs after breach", () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 300_000 });
    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");
    expect(limiter.check("10.0.0.1")).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check("10.0.0.1")).toBe(false);

    vi.advanceTimersByTime(240_000);
    expect(limiter.check("10.0.0.1")).toBe(true);
  });

  it("tracks IPs independently", () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000, lockoutMs: 0 });
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    expect(limiter.check("1.1.1.1")).toBe(false);

    expect(limiter.check("2.2.2.2")).toBe(true);
  });
});
