const MAX_PATH_LENGTH = 1024;
const DOUBLE_DOT_SEGMENT = /(?:^|\/)\.\.\//;

function normalizeRelativeSyncPath(relativePath: string): string {
  return relativePath
    .replace(/\/+/g, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/")
    .replace(/\/$/, "");
}

export type PathValidationResult =
  | { valid: true; key: string }
  | { valid: false; reason: string };

export function resolveWithinObjectPrefix(
  objectPrefix: string,
  relativePath: string,
): PathValidationResult {
  const path = validateRelativeSyncPath(relativePath);
  if (!path.valid) return path;
  return { valid: true, key: `${objectPrefix}/${path.normalized}` };
}

type RelativePathValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; reason: string };

function validateRelativeSyncPath(relativePath: string): RelativePathValidationResult {
  if (!relativePath || relativePath.length === 0) {
    return { valid: false, reason: "Path must not be empty" };
  }

  if (relativePath.length > MAX_PATH_LENGTH) {
    return { valid: false, reason: `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters` };
  }

  if (relativePath.startsWith("/")) {
    return { valid: false, reason: "Path must not start with /" };
  }

  if (relativePath.includes("\\")) {
    return { valid: false, reason: "Path must not contain backslashes" };
  }

  if (DOUBLE_DOT_SEGMENT.test(relativePath) || relativePath === ".." || relativePath.endsWith("/..")) {
    return { valid: false, reason: "Path must not contain '..' segments" };
  }

  if (relativePath.includes("\0")) {
    return { valid: false, reason: "Path must not contain null bytes" };
  }

  // Normalize redundant separators and no-op "." segments so logically
  // identical paths always resolve to the same sync key.
  const normalized = normalizeRelativeSyncPath(relativePath);

  if (normalized.length === 0) {
    return { valid: false, reason: "Path resolves to empty after normalization" };
  }

  return { valid: true, normalized };
}

export function resolveWithinPrefix(
  userId: string,
  relativePath: string,
): PathValidationResult {
  return resolveWithinObjectPrefix(`matrixos-sync/${userId}/files`, relativePath);
}

export function validatePathBatch(
  userId: string,
  paths: string[],
): { valid: string[]; invalid: Array<{ path: string; reason: string }> } {
  const valid: string[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];

  for (const path of paths) {
    const result = resolveWithinPrefix(userId, path);
    if (result.valid) {
      valid.push(result.key);
    } else {
      invalid.push({ path, reason: result.reason });
    }
  }

  return { valid, invalid };
}
