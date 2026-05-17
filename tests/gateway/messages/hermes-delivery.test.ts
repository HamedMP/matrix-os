import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  createHermesCapabilityToken,
  verifyHermesCapabilityToken,
} from "../../../packages/gateway/src/messages/hermes-capability.js";
import { HermesDeliveryRegistry } from "../../../packages/gateway/src/messages/hermes-delivery.js";

describe("Hermes capability tokens", () => {
  it("scopes tokens to owner, room, action, and a 60-second maximum TTL", () => {
    const token = createHermesCapabilityToken({
      secret: "super-secret-runtime-key",
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      ttlMs: 60_000,
      nowMs: 1_000,
    });

    expect(verifyHermesCapabilityToken({
      token,
      secret: "super-secret-runtime-key",
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      nowMs: 10_000,
    })).toMatchObject({ ownerId: "user_a", roomId: "!room:matrixos.local" });

    expect(verifyHermesCapabilityToken({
      token,
      secret: "super-secret-runtime-key",
      ownerId: "user_b",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      nowMs: 10_000,
    })).toBeNull();
  });

  it("rejects expired, overlong, and tampered tokens", () => {
    const token = createHermesCapabilityToken({
      secret: "super-secret-runtime-key",
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      ttlMs: 120_000,
      nowMs: 1_000,
    });

    expect(verifyHermesCapabilityToken({
      token,
      secret: "super-secret-runtime-key",
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      nowMs: 70_000,
    })).toBeNull();
    expect(verifyHermesCapabilityToken({
      token: `${token}tampered`,
      secret: "super-secret-runtime-key",
      ownerId: "user_a",
      roomId: "!room:matrixos.local",
      scope: "messages.reply.request",
      nowMs: 10_000,
    })).toBeNull();
  });

  it("normalizes token comparisons before timing-safe equality", () => {
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
    expect(constantTimeEqual("same", "same")).toBe(true);
  });
});

describe("HermesDeliveryRegistry", () => {
  it("evicts the oldest inserted entry when capacity is reached", () => {
    const registry = new HermesDeliveryRegistry(2, 60_000);

    const first = registry.register("abort_1", 1);
    const second = registry.register("abort_2", 2);
    const third = registry.register("abort_3", 3);

    expect(registry.size()).toBe(2);
    expect(registry.abort("abort_1")).toBe(false);
    expect(first.aborted).toBe(false);
    expect(registry.abort("abort_2")).toBe(true);
    expect(second.aborted).toBe(true);
    expect(registry.abort("abort_3")).toBe(true);
    expect(third.aborted).toBe(true);
  });

  it("treats duplicate registration as the newest entry for capacity eviction", () => {
    const registry = new HermesDeliveryRegistry(2, 60_000);

    const originalFirst = registry.register("abort_1", 1);
    const second = registry.register("abort_2", 2);
    const refreshedFirst = registry.register("abort_1", 3);
    const third = registry.register("abort_3", 4);

    expect(registry.size()).toBe(2);
    expect(registry.abort("abort_2")).toBe(false);
    expect(second.aborted).toBe(false);
    expect(registry.abort("abort_1")).toBe(true);
    expect(originalFirst.aborted).toBe(false);
    expect(refreshedFirst.aborted).toBe(true);
    expect(registry.abort("abort_3")).toBe(true);
    expect(third.aborted).toBe(true);
  });
});
