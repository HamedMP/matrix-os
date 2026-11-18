// Installed only in the pinned hosted OpenMausBot daemon. The host pairing
// proof is already passed on stdin, stays in this process, and is never
// inherited by child processes. It seals the one-purpose broker capability
// in the existing on-disk routine; it is not a provider credential.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let key: Buffer | undefined;

export function setMatrixScheduleSealKey(pairingProof: Buffer) {
  key = createHmac("sha256", pairingProof).update("matrix-hosted-bots/schedule-seal/v1").digest();
}

export function sealMatrixSchedule(header: string | string[] | undefined) {
  if (!key || typeof header !== "string") return undefined;
  const [routineId, token, extra] = header.split(":");
  if (!routineId || !ID.test(routineId) || !token || !/^[a-f0-9]{64}$/.test(token) || extra !== undefined) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(routineId));
  const payload = Buffer.concat([cipher.update(Buffer.from(token, "hex")), cipher.final()]);
  return { routineId, sealedGrant: Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64url") };
}

export function openMatrixSchedule(routineId: string, sealedGrant: string) {
  if (!key || !ID.test(routineId) || !/^[A-Za-z0-9_-]{80}$/.test(sealedGrant)) return undefined;
  const data = Buffer.from(sealedGrant, "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12))
      .setAAD(Buffer.from(routineId)).setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("hex");
  } catch (error) {
    // Bad or copied ciphertext is not an authorized schedule.
    if (error instanceof Error) return undefined;
    throw error;
  }
}
