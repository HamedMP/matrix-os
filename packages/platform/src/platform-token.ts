import { createHmac, timingSafeEqual } from "node:crypto";

export function timingSafeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  const maxLen = Math.max(actualBuf.length, expectedBuf.length);
  if (maxLen === 0) return false;
  const paddedActual = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  actualBuf.copy(paddedActual);
  expectedBuf.copy(paddedExpected);
  const lengthMatch = actualBuf.length === expectedBuf.length;
  const contentMatch = timingSafeEqual(paddedActual, paddedExpected);
  return lengthMatch && contentMatch;
}

export function buildPlatformVerificationToken(handle: string, platformSecret: string): string {
  return createHmac("sha256", platformSecret).update(handle).digest("hex");
}

type RuntimeIdentity = { handle: string; machineId: string; runtimeSlot: string };

function runtimeTokenPayload(kind: string, identity: RuntimeIdentity, epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 2_147_483_647) {
    throw new Error("Invalid runtime token epoch");
  }
  // Epoch 1 must preserve existing host tokens until that machine is rotated.
  const prefix = [kind, epoch === 1 ? 1 : 2, identity.handle, identity.machineId, identity.runtimeSlot];
  return JSON.stringify(epoch === 1 ? prefix : [...prefix, epoch]);
}

export function buildPlatformRuntimeVerificationToken(
  identity: RuntimeIdentity,
  platformSecret: string,
  epoch = 1,
): string {
  return createHmac("sha256", platformSecret)
    .update(runtimeTokenPayload("matrix-funded-ai-runtime", identity, epoch))
    .digest("hex");
}

export function buildPlatformSyncVerificationToken(
  identity: RuntimeIdentity,
  platformSecret: string,
  epoch = 1,
): string {
  return createHmac("sha256", platformSecret)
    .update(runtimeTokenPayload("matrix-sync-runtime", identity, epoch))
    .digest("hex");
}

export function buildPlatformSpeechRuntimeVerificationToken(
  identity: RuntimeIdentity,
  platformSecret: string,
  epoch = 1,
): string {
  return createHmac("sha256", platformSecret)
    .update(runtimeTokenPayload("matrix-platform-speech-runtime", identity, epoch))
    .digest("hex");
}

/**
 * Spec 2707: an owned machine's only bearer for platform<->machine traffic.
 * Bound to machine, slot and epoch, so revocation is an epoch bump. Owned
 * machines never receive the handle-wide verification token, which other
 * runtimes of the same owner still use.
 */
export function buildOwnedMachineVerificationToken(
  identity: RuntimeIdentity,
  platformSecret: string,
  epoch: number,
): string {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 2_147_483_647) {
    throw new Error("Invalid runtime token epoch");
  }
  return createHmac("sha256", platformSecret)
    .update(JSON.stringify(["matrix-owned-machine", 1, identity.handle, identity.machineId, identity.runtimeSlot, epoch]))
    .digest("hex");
}

type RuntimeAuthMachine = RuntimeIdentity & { substrate?: string; runtimeTokenEpoch?: number };

/** The bearer the platform presents to, and accepts from, one runtime. */
export function buildRuntimeAuthToken(machine: RuntimeAuthMachine, platformSecret: string): string {
  if (machine.substrate === "owned") {
    return buildOwnedMachineVerificationToken(machine, platformSecret, machine.runtimeTokenEpoch ?? 1);
  }
  return buildPlatformVerificationToken(machine.handle, platformSecret);
}
