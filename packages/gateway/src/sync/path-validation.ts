const MAX_PATH_LENGTH = 1024;
const DOUBLE_DOT_SEGMENT = /(?:^|\/)\.\.\//;

export type PathValidationResult =
  | { valid: true; key: string }
  | { valid: false; reason: string };

export function resolveWithinPrefix(
  userId: string,
  relativePath: string,
): PathValidationResult {
  if (!relativePath || relativePath.length === 0) {
    return { valid: false, reason: "Path must not be empty" };
  }

  if (relativePath.length > MAX_PATH_LENGTH) {
    return { valid: false, reason: `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters` };
  }

  if (relativePath.startsWith("/")) {
    return { valid: false, reason: "Path must not start with /" };
  }

  if (DOUBLE_DOT_SEGMENT.test(relativePath) || relativePath === ".." || relativePath.endsWith("/..")) {
    return { valid: false, reason: "Path must not contain '..' segments" };
  }

  if (relativePath.includes("\0")) {
    return { valid: false, reason: "Path must not contain null bytes" };
  }

  // Normalize consecutive slashes
  const normalized = relativePath.replace(/\/+/g, "/").replace(/\/$/, "");

  if (normalized.length === 0) {
    return { valid: false, reason: "Path resolves to empty after normalization" };
  }

  const key = `matrixos-sync/${userId}/files/${normalized}`;
  return { valid: true, key };
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
