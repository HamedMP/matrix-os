import { createHash } from "node:crypto";

const SAFE_SYNC_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SAFE_RUNTIME_SLOT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_SYNC_ID_LENGTH = 256;
const MAX_PEER_ID_LENGTH = 128;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function capWithHash(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = `_${shortHash(value)}`;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

export function deriveHomeMirrorSyncIdentity(input: {
  baseUserId: string;
  runtimeSlot?: string;
}): { syncUserId: string; peerId: string } {
  const runtimeSlot = input.runtimeSlot?.trim() || "primary";
  if (!SAFE_RUNTIME_SLOT.test(runtimeSlot)) {
    throw new Error("Invalid MATRIX_RUNTIME_SLOT for home mirror sync identity");
  }

  const baseUserId = input.baseUserId.trim();
  if (!SAFE_SYNC_ID.test(baseUserId)) {
    throw new Error("Invalid MATRIX_USER_ID for home mirror sync identity");
  }

  const syncUserId = runtimeSlot === "primary"
    ? baseUserId
    : capWithHash(`${baseUserId}__slot_${runtimeSlot}`, MAX_SYNC_ID_LENGTH);

  return {
    syncUserId,
    peerId: capWithHash(`gateway-${syncUserId}`, MAX_PEER_ID_LENGTH),
  };
}
