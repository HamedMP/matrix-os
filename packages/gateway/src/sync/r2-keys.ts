import { resolveWithinPrefix } from "./path-validation.js";

const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function buildFileKey(userId: string, relativePath: string): string {
  assertSafeUserId(userId);
  const validated = resolveWithinPrefix(userId, relativePath);
  if (!validated.valid) {
    throw new Error(`Invalid sync path: ${validated.reason}`);
  }
  return validated.key;
}

export function buildManifestKey(userId: string): string {
  assertSafeUserId(userId);
  return `matrixos-sync/${userId}/manifest.json`;
}

export function buildManifestGenerationKey(
  userId: string,
  version: number,
  sha256: string,
): string {
  assertSafeUserId(userId);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Invalid sync manifest version");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid sync manifest hash");
  }
  return `matrixos-sync/${userId}/manifests/${version}-${sha256}.json`;
}

export function assertSafeUserId(userId: string): void {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid sync user id");
  }
}
