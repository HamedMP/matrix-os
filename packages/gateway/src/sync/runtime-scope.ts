import { createHash } from "node:crypto";
import {
  buildSyncStoragePrefix,
  SyncScopeSchema,
  type SyncScope,
} from "@matrix-os/contracts";

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

export function resolveSyncScope(input: {
  ownerId: string;
  runtimeSlot?: string;
}): SyncScope {
  return SyncScopeSchema.parse({
    ownerId: input.ownerId.trim(),
    runtimeSlot: input.runtimeSlot?.trim() || "primary",
  });
}

/**
 * Primary keeps the deployed prefix. Every other runtime uses a versioned,
 * structurally unambiguous namespace so owner and runtime segments cannot be
 * confused with legacy owner identifiers.
 */
export function buildSyncScopePrefix(scope: SyncScope): string {
  return buildSyncStoragePrefix(scope);
}

export function syncScopeRegistryKey(scope: SyncScope): string {
  const parsed = SyncScopeSchema.parse(scope);
  return parsed.runtimeSlot === "primary"
    ? parsed.ownerId
    : `${parsed.ownerId}\0${parsed.runtimeSlot}`;
}

export function deriveHomeMirrorSyncIdentity(input: {
  baseUserId: string;
  runtimeSlot?: string;
}): { syncUserId: string; peerId: string } {
  let scope: SyncScope;
  try {
    scope = resolveSyncScope({
      ownerId: input.baseUserId,
      runtimeSlot: input.runtimeSlot,
    });
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    console.warn("[sync] Invalid sync input", err.name);
    const runtimeSlot = input.runtimeSlot?.trim() || "primary";
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(runtimeSlot)) {
      throw new Error("Invalid MATRIX_RUNTIME_SLOT for home mirror sync identity");
    }
    throw new Error("Invalid MATRIX_USER_ID for home mirror sync identity");
  }

  const syncUserId = scope.runtimeSlot === "primary"
    ? scope.ownerId
    : capWithHash(`${scope.ownerId}__slot_${scope.runtimeSlot}`, MAX_SYNC_ID_LENGTH);

  return {
    syncUserId,
    peerId: capWithHash(`gateway-${syncUserId}`, MAX_PEER_ID_LENGTH),
  };
}
