import { describe, expect, it } from "vitest";
import { LaunchTokenCache, type LaunchToken } from "@desktop/main/embeds/launch-token-cache";

function token(expiresAt: number, launchUrl = "/apps/notes/"): LaunchToken {
  return { launchUrl, expiresAt };
}

describe("LaunchTokenCache", () => {
  it("returns cached tokens while fresh", () => {
    let now = 1_000_000;
    const cache = new LaunchTokenCache({ clock: () => now });
    cache.set("notes", token(now + 120_000));
    expect(cache.get("notes")).toEqual(token(1_120_000));
  });

  it("returns null for unknown slugs", () => {
    const cache = new LaunchTokenCache({ clock: () => 0 });
    expect(cache.get("missing")).toBeNull();
  });

  it("treats tokens within 30s of expiry as stale (TTL safety margin)", () => {
    let now = 1_000_000;
    const cache = new LaunchTokenCache({ clock: () => now });
    const expiresAt = now + 60_000;
    cache.set("notes", token(expiresAt));

    now = expiresAt - 30_000;
    expect(cache.get("notes")).toEqual(token(expiresAt));

    now = expiresAt - 29_999;
    expect(cache.get("notes")).toBeNull();
  });

  it("evicts the least-recently-used entry beyond the cap", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ cap: 2, clock: () => now });
    cache.set("a", token(100_000, "/a"));
    cache.set("b", token(100_000, "/b"));
    cache.set("c", token(100_000, "/c"));
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toEqual(token(100_000, "/b"));
    expect(cache.get("c")).toEqual(token(100_000, "/c"));
  });

  it("refreshes recency on get", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ cap: 2, clock: () => now });
    cache.set("a", token(100_000, "/a"));
    cache.set("b", token(100_000, "/b"));
    cache.get("a");
    cache.set("c", token(100_000, "/c"));
    expect(cache.get("a")).toEqual(token(100_000, "/a"));
    expect(cache.get("b")).toBeNull();
  });

  it("evicts stale entries on get before later cap enforcement", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ cap: 2, clock: () => now });
    cache.set("fresh", token(200_000, "/fresh"));
    cache.set("stale", token(60_000, "/stale"));

    now = 40_000;
    expect(cache.get("stale")).toBeNull();
    cache.set("new", token(200_000, "/new"));

    expect(cache.get("fresh")).toEqual(token(200_000, "/fresh"));
    expect(cache.get("new")).toEqual(token(200_000, "/new"));
  });

  it("refreshes recency and replaces the token on re-set", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ cap: 2, clock: () => now });
    cache.set("a", token(100_000, "/a"));
    cache.set("b", token(100_000, "/b"));
    cache.set("a", token(200_000, "/a2"));
    cache.set("c", token(100_000, "/c"));
    expect(cache.get("a")).toEqual(token(200_000, "/a2"));
    expect(cache.get("b")).toBeNull();
  });

  it("defaults the cap to 32", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ clock: () => now });
    for (let i = 0; i < 33; i++) {
      cache.set(`app-${i}`, token(100_000, `/app-${i}`));
    }
    expect(cache.get("app-0")).toBeNull();
    expect(cache.get("app-1")).toEqual(token(100_000, "/app-1"));
    expect(cache.get("app-32")).toEqual(token(100_000, "/app-32"));
  });

  it("clears all entries", () => {
    let now = 0;
    const cache = new LaunchTokenCache({ clock: () => now });
    cache.set("a", token(100_000));
    cache.clear();
    expect(cache.get("a")).toBeNull();
  });
});
