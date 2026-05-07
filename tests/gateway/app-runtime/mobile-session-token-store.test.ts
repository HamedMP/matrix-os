import { describe, expect, it } from "vitest";
import { MobileAppSessionTokenStore } from "../../../packages/gateway/src/app-runtime/mobile-session-token-store.js";

describe("MobileAppSessionTokenStore", () => {
  it("mints single-use tokens scoped to one app slug", () => {
    const store = new MobileAppSessionTokenStore({ ttlMs: 1_000, maxEntries: 10 });
    const { token } = store.mint("calculator", 1_000);

    expect(store.consume("chess", token, 1_001)).toBe(false);
    expect(store.consume("calculator", token, 1_001)).toBe(false);
  });

  it("accepts a token once before expiry", () => {
    const store = new MobileAppSessionTokenStore({ ttlMs: 1_000, maxEntries: 10 });
    const { token } = store.mint("calculator", 1_000);

    expect(store.consume("calculator", token, 1_500)).toBe(true);
    expect(store.consume("calculator", token, 1_501)).toBe(false);
  });

  it("can prefix tokens with a routing key without weakening consume checks", () => {
    const store = new MobileAppSessionTokenStore({ ttlMs: 1_000, maxEntries: 10 });
    const { token } = store.mint("calculator", 1_000, { routingKey: "alice" });

    expect(token.startsWith("alice.")).toBe(true);
    expect(store.consume("calculator", token, 1_500)).toBe(true);
  });

  it("expires old tokens", () => {
    const store = new MobileAppSessionTokenStore({ ttlMs: 1_000, maxEntries: 10 });
    const { token } = store.mint("calculator", 1_000);

    expect(store.consume("calculator", token, 2_001)).toBe(false);
  });

  it("evicts oldest entries at the configured cap", () => {
    const store = new MobileAppSessionTokenStore({ ttlMs: 10_000, maxEntries: 2 });
    const first = store.mint("a", 1_000).token;
    const second = store.mint("b", 1_001).token;
    const third = store.mint("c", 1_002).token;

    expect(store.size()).toBe(2);
    expect(store.consume("a", first, 1_003)).toBe(false);
    expect(store.consume("b", second, 1_003)).toBe(true);
    expect(store.consume("c", third, 1_003)).toBe(true);
  });
});
