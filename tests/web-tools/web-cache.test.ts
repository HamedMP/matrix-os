import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WebCache } from "../../packages/kernel/src/tools/web-cache.js";

describe("WebCache", () => {
  let cache: WebCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new WebCache({ defaultTtlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves entries", () => {
    cache.set("key1", { data: "hello" });
    expect(cache.get("key1")).toEqual({ data: "hello" });
  });

  it("returns undefined for missing keys", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    cache.set("key1", "value1");
    vi.advanceTimersByTime(999);
    expect(cache.get("key1")).toBe("value1");
    vi.advanceTimersByTime(2);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("allows per-entry TTL override", () => {
    cache.set("short", "gone soon", 500);
    cache.set("long", "stays", 2000);

    vi.advanceTimersByTime(600);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("stays");
  });

  it("clear() removes all entries", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("size() returns correct count", () => {
    expect(cache.size()).toBe(0);
    cache.set("a", 1);
    expect(cache.size()).toBe(1);
    cache.set("b", 2);
    expect(cache.size()).toBe(2);
  });

  it("does not count expired entries in size()", () => {
    cache.set("a", 1, 500);
    cache.set("b", 2, 2000);
    vi.advanceTimersByTime(600);
    expect(cache.size()).toBe(1);
  });

  it("overwrites existing entries", () => {
    cache.set("key", "old");
    cache.set("key", "new");
    expect(cache.get("key")).toBe("new");
    expect(cache.size()).toBe(1);
  });

  describe("normalizeUrl", () => {
    it("strips trailing slash", () => {
      cache.set(WebCache.normalizeUrl("https://example.com/"), "val");
      expect(cache.get(WebCache.normalizeUrl("https://example.com"))).toBe("val");
    });

    it("sorts query parameters", () => {
      const url1 = WebCache.normalizeUrl("https://example.com?b=2&a=1");
      const url2 = WebCache.normalizeUrl("https://example.com?a=1&b=2");
      expect(url1).toBe(url2);
    });

    it("lowercases hostname", () => {
      const url1 = WebCache.normalizeUrl("https://EXAMPLE.COM/path");
      const url2 = WebCache.normalizeUrl("https://example.com/path");
      expect(url1).toBe(url2);
    });
  });
});
