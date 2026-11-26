import { describe, expect, it } from "vitest";
import {
  DesktopPairingActionProofSchema,
  DesktopPairingChallengeSchema,
  DesktopPairingCompleteSchema,
  DesktopPairingStateSchema,
  desktopPairingActionProofMessage,
  desktopPairingProofMessage,
} from "../../packages/contracts/src/index";

const machineId = "4456d7a1-173b-48e0-9e2c-321f30c7dc70";
const deviceId = "a".repeat(64);
const nonce = "b".repeat(42) + "A";

describe("Mac pairing contract", () => {
  it("binds the exact owner, Computer, device, revision and nonce in order", () => {
    const challenge = { machineId, deviceId, revision: 3, nonce, expiresAt: 1_900_000_000_000 };
    expect(DesktopPairingChallengeSchema.parse(challenge)).toEqual(challenge);
    expect(JSON.parse(desktopPairingProofMessage({ ownerId: "user_alice", ...challenge })))
      .toEqual(["matrix-desktop-pairing-v1", "user_alice", machineId, deviceId, 3, nonce]);
  });

  it("keeps action proof distinct from enrollment and uses the stored public key", () => {
    const challenge = { ownerId: "user_alice", machineId, deviceId, revision: 3, nonce };
    expect(JSON.parse(desktopPairingActionProofMessage(challenge)))
      .toEqual(["matrix-desktop-pairing-action-v1", "user_alice", machineId, deviceId, 3, nonce]);
    expect(desktopPairingActionProofMessage(challenge)).not.toBe(desktopPairingProofMessage(challenge));
    const proof = { nonce, signature: "A".repeat(86) };
    expect(DesktopPairingActionProofSchema.parse(proof)).toEqual(proof);
    expect(DesktopPairingActionProofSchema.safeParse({ ...proof, publicKey: "A".repeat(59) }).success).toBe(false);
  });

  it("rejects ambiguous inputs, invalid keys and unsafe revisions", () => {
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId: null, revision: 2 }).success).toBe(true);
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId, revision: 2, ownerId: "user_alice" }).success).toBe(false);
    expect(DesktopPairingStateSchema.safeParse({ machineId, deviceId, revision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(DesktopPairingCompleteSchema.safeParse({ nonce, publicKey: "A".repeat(59), signature: "A".repeat(86) }).success).toBe(true);
    expect(DesktopPairingCompleteSchema.safeParse({ nonce, publicKey: "A".repeat(58) + "=", signature: "A".repeat(86) }).success).toBe(false);
  });
});
