import { describe, expect, it } from "vitest";
import { PR_CACHE_LIMITS, PullRequestCache } from "../../../packages/gateway/src/project-tasks/pr-cache.js";

const ok = { status: "ok" as const, pullRequest: null };

describe("PullRequestCache", () => {
  it("defaults to 500 entries and a 60 second TTL", () => {
    expect(PR_CACHE_LIMITS).toEqual({ entries: 500, ttlMs: 60_000 });
  });

  it("expires entries after the TTL", () => {
    let now = 0;
    const cache = new PullRequestCache(10, 60_000, () => now);
    cache.set("a", ok);
    now = 59_999;
    expect(cache.get("a")).toEqual(ok);
    now = 60_000 + 59_999;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry beyond the cap", () => {
    const cache = new PullRequestCache(2, 60_000, () => 0);
    cache.set("a", ok);
    cache.set("b", ok);
    cache.get("a");
    cache.set("c", { status: "unavailable" });
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(ok);
    expect(cache.get("c")).toEqual({ status: "unavailable" });
  });

  it("never grows past the cap", () => {
    const cache = new PullRequestCache(500, 60_000, () => 0);
    for (let index = 0; index < 2_000; index += 1) cache.set(`k${index}`, ok);
    expect(cache.size).toBe(500);
  });
});
