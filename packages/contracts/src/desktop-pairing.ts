import { z } from "zod/v4";

const machineId = z.uuid();
const revision = z.int().nonnegative();
const nonce = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const DesktopPairingDeviceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const DesktopPairingStateSchema = z.strictObject({
  machineId,
  deviceId: DesktopPairingDeviceIdSchema.nullable(),
  revision,
});
export const DesktopPairingChallengeRequestSchema = z.strictObject({
  deviceId: DesktopPairingDeviceIdSchema,
  revision,
});
export const DesktopPairingChallengeSchema = DesktopPairingChallengeRequestSchema.extend({
  machineId,
  nonce,
  expiresAt: z.int().positive(),
});
export const DesktopPairingCompleteSchema = z.strictObject({
  nonce,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{58}[AEIMQUYcgkosw048]$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
});
export const DesktopPairingActionProofSchema = DesktopPairingCompleteSchema.pick({ nonce: true, signature: true });
export const DesktopPairingRevokeSchema = z.strictObject({ revision });

/** Binds an approved mutation to one Computer even if its HTTPS origin is reassigned. */
export function desktopPairingRevisionTag(input: { machineId: string; deviceId: string; revision: number }): string {
  return `"desktop-pairing-${input.machineId}-${input.deviceId}-${input.revision}"`;
}

interface DesktopPairingProof {
  ownerId: string;
  machineId: string;
  deviceId: string;
  revision: number;
  nonce: string;
}

function proofMessage(domain: string, input: DesktopPairingProof): string {
  return JSON.stringify([domain, input.ownerId, input.machineId, input.deviceId, input.revision, input.nonce]);
}

export function desktopPairingProofMessage(input: DesktopPairingProof): string {
  return proofMessage("matrix-desktop-pairing-v1", input);
}

export function desktopPairingActionProofMessage(input: DesktopPairingProof): string {
  return proofMessage("matrix-desktop-pairing-action-v1", input);
}
