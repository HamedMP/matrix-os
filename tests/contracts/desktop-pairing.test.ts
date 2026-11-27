import { describe, expect, it } from "vitest";
import {
  DesktopPairingChallengeSchema,
  DesktopPairingCompleteSchema,
  DesktopPairingStateSchema,
  desktopPairingProofMessage,
} from "../../packages/contracts/src/index";

const machineId = "4456d7a1-173b-48e0-9e2c-321f30c7dc70";
const deviceId = "a".repeat(64);
const nonce = "b".repeat(42) + "A";

describe("Desktop Link device enrollment contract", () => {
  it("binds the exact owner, Computer, device, revision and nonce in order", () => {
    const challenge = { machineId, deviceId, revision: 3, nonce, expiresAt: 1_900_000_000_000 };
    expect(DesktopPairingChallengeSchema.parse(challenge)).toEqual(challenge);
    expect(JSON.parse(desktopPairingProofMessage({ ownerId: "user_alice", ...challenge })))
      .toEqual(["matrix-desktop-pairing-v1", "user_alice", machineId, deviceId, 3, nonce]);
  });

  it("rejects ambiguous inputs, invalid keys and unsafe revisions", () => {
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId: null, revision: 2 }).success).toBe(true);
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId, revision: 2, ownerId: "user_alice" }).success).toBe(false);
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId, revision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(DesktopPairingCompleteSchema.safeParse({ nonce, publicKey: "A".repeat(59), signature: "A".repeat(86) }).success).toBe(true);
    expect(DesktopPairingCompleteSchema.safeParse({ nonce, publicKey: "A".repeat(58) + "=", signature: "A".repeat(86) }).success).toBe(false);
  });
});
