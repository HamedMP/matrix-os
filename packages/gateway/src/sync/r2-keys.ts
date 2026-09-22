import type { SyncScope } from "@matrix-os/contracts";
import { resolveWithinObjectPrefix } from "./path-validation.js";
import { buildSyncScopePrefix, resolveSyncScope } from "./runtime-scope.js";

const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;

export type SyncKeyScope = string | SyncScope;

function normalizedScope(scope: SyncKeyScope): SyncScope {
  if (typeof scope === "string") {
    assertSafeUserId(scope);
    return resolveSyncScope({ ownerId: scope, runtimeSlot: "primary" });
  }
  return resolveSyncScope(scope);
}

export function buildFileKey(scope: SyncKeyScope, relativePath: string): string {
  const prefix = buildSyncScopePrefix(normalizedScope(scope));
  const validated = resolveWithinObjectPrefix(`${prefix}/files`, relativePath);
  if (!validated.valid) {
    throw new Error(`Invalid sync path: ${validated.reason}`);
  }
  return validated.key;
}

export function buildManifestKey(scope: SyncKeyScope): string {
  return `${buildSyncScopePrefix(normalizedScope(scope))}/manifest.json`;
}

export function buildManifestGenerationKey(
  scope: SyncKeyScope,
  version: number,
  sha256: string,
): string {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Invalid sync manifest version");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid sync manifest hash");
  }
  return `${buildSyncScopePrefix(normalizedScope(scope))}/manifests/${version}-${sha256}.json`;
}

export function buildStagingKey(scope: SyncKeyScope, stagingId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stagingId)) {
    throw new Error("Invalid sync staging id");
  }
  return `${buildSyncScopePrefix(normalizedScope(scope))}/staging/${stagingId}`;
}

export function buildBlobKey(scope: SyncKeyScope, hash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(hash);
  if (!match) throw new Error("Invalid sync blob hash");
  return `${buildSyncScopePrefix(normalizedScope(scope))}/objects/sha256/${match[1]}`;
}

export function assertSafeUserId(userId: string): void {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid sync user id");
  }
}
