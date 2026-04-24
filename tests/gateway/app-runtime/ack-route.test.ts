import { describe, it, expect, beforeEach } from "vitest";
import { AckStore } from "../../../packages/gateway/src/app-runtime/ack-store.js";

let store: AckStore;

beforeEach(() => {
  store = new AckStore({ cap: 32, ttlMs: 5 * 60 * 1000 });
});

describe("AckStore", () => {
  it("mints an opaque token tied to slug and principal", () => {
    const { ack, expiresAt } = store.mint("notes", "gateway-owner");
    expect(typeof ack).toBe("string");
    expect(ack.length).toBeGreaterThan(0);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("peekAck returns the record without consuming it", () => {
    const { ack } = store.mint("notes", "gateway-owner");
    const record = store.peekAck("notes", "gateway-owner", ack);
    expect(record).not.toBeNull();
    expect(record!.slug).toBe("notes");
    expect(record!.principal).toBe("gateway-owner");

    // Peek again -- still available
    const record2 = store.peekAck("notes", "gateway-owner", ack);
    expect(record2).not.toBeNull();
  });

  it("consumeAck returns the record and deletes it (one-time)", () => {
    const { ack } = store.mint("notes", "gateway-owner");
    const record = store.consumeAck("notes", "gateway-owner", ack);
    expect(record).not.toBeNull();

    // Second consumption returns null
    const record2 = store.consumeAck("notes", "gateway-owner", ack);
    expect(record2).toBeNull();
  });

  it("peekAck returns null for wrong ack token", () => {
    store.mint("notes", "gateway-owner");
    const record = store.peekAck("notes", "gateway-owner", "wrong-token");
    expect(record).toBeNull();
  });

  it("peekAck returns null for wrong slug", () => {
    const { ack } = store.mint("notes", "gateway-owner");
    const record = store.peekAck("calendar", "gateway-owner", ack);
    expect(record).toBeNull();
  });

  it("peekAck returns null for wrong principal", () => {
    const { ack } = store.mint("notes", "gateway-owner");
    const record = store.peekAck("notes", "other-user", ack);
    expect(record).toBeNull();
  });

  it("expired tokens are rejected", () => {
    const shortStore = new AckStore({ cap: 32, ttlMs: 1 });
    const { ack } = shortStore.mint("notes", "gateway-owner");

    // Wait for expiry
    const waitUntil = Date.now() + 5;
    while (Date.now() < waitUntil) {
      // spin wait
    }

    const record = shortStore.peekAck("notes", "gateway-owner", ack);
    expect(record).toBeNull();
  });

  it("bounded LRU eviction: oldest evicted when cap reached", () => {
    const tinyStore = new AckStore({ cap: 3, ttlMs: 60_000 });

    const { ack: ack1 } = tinyStore.mint("app1", "user");
    tinyStore.mint("app2", "user");
    tinyStore.mint("app3", "user");

    // At cap. Mint one more -- should evict app1 (oldest)
    tinyStore.mint("app4", "user");
    expect(tinyStore.size).toBeLessThanOrEqual(3);

    const evicted = tinyStore.peekAck("app1", "user", ack1);
    expect(evicted).toBeNull();
  });

  it("re-minting for same slug+principal overwrites previous token", () => {
    const { ack: ack1 } = store.mint("notes", "gateway-owner");
    const { ack: ack2 } = store.mint("notes", "gateway-owner");

    expect(ack1).not.toBe(ack2);

    // Old token no longer valid
    const record1 = store.peekAck("notes", "gateway-owner", ack1);
    expect(record1).toBeNull();

    // New token is valid
    const record2 = store.peekAck("notes", "gateway-owner", ack2);
    expect(record2).not.toBeNull();
  });
});
