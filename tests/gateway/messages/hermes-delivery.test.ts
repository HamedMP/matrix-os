import { describe, expect, it } from "vitest";
import {
  createHermesCapabilityToken,
  verifyHermesCapabilityToken,
} from "../../../packages/gateway/src/messages/hermes-capability.js";

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
});
