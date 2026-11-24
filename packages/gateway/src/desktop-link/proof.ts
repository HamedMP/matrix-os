// Device proofs and the challenges they sign (spec 2716). The checks follow
// 2698's desktop pairing; once that lands, both share one verifier.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

/** True only for a valid Ed25519 signature by the key whose SHA-256 is `deviceId`. */
export function verifyDeviceProof(deviceId: string, encodedPublicKey: string, encodedSignature: string, message: string): boolean {
  const publicKey = Buffer.from(encodedPublicKey, "base64url");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (publicKey.toString("base64url") !== encodedPublicKey || signature.toString("base64url") !== encodedSignature
      || createHash("sha256").update(publicKey).digest("hex") !== deviceId) return false;
  try {
    const key = createPublicKey({ key: publicKey, type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(message), key, signature);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_OSSL_")) {
      return false;
    }
    throw error;
  }
}

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export interface PendingChallenge { deviceId: string; nonce: string; expiresAt: number }

/**
 * Single-use enrolment challenges, at most `perDevice` live for one device and
 * `max` in all, each for `ttlMs`. Not kept across restarts.
 */
export function createChallengeStore(options: { now: () => number; ttlMs?: number; max?: number; perDevice?: number }) {
  const ttlMs = options.ttlMs ?? 60_000;
  const max = options.max ?? 100;
  const perDevice = options.perDevice ?? 5;
  const pending = new Map<string, PendingChallenge>();

  function sweep(at: number): void {
    for (const [nonce, challenge] of pending) if (challenge.expiresAt <= at) pending.delete(nonce);
  }

  return {
    issue(deviceId: string): PendingChallenge | null {
      const at = options.now();
      sweep(at);
      let forDevice = 0;
      for (const challenge of pending.values()) if (challenge.deviceId === deviceId) forDevice += 1;
      if (forDevice >= perDevice) return null;
      if (pending.size >= max) {
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      const challenge = { deviceId, nonce: newNonce(), expiresAt: at + ttlMs };
      pending.set(challenge.nonce, challenge);
      return challenge;
    },
    /** Removes the challenge whether or not it is still valid; returns it only if valid. */
    consume(nonce: string): PendingChallenge | undefined {
      const challenge = pending.get(nonce);
      pending.delete(nonce);
      return challenge && challenge.expiresAt > options.now() ? challenge : undefined;
    },
    size: () => pending.size,
    clear: () => pending.clear(),
  };
}
