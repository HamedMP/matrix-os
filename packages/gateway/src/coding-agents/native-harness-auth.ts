import { stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_AUTH_FILE_BYTES = 1024 * 1024;

function authPath(homePath: string, harness: "pi" | "opencode"): string {
  return harness === "pi"
    ? join(homePath, ".pi", "agent", "auth.json")
    : join(homePath, ".local", "share", "opencode", "auth.json");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/**
 * Checks only bounded metadata at each CLI's fixed owner-local credential path.
 * Credential bytes and provider identities never enter Matrix state or logs.
 */
export async function hasNativeHarnessAuth(
  homePath: string,
  harness: "pi" | "opencode",
): Promise<boolean> {
  try {
    const metadata = await stat(authPath(homePath, harness));
    return metadata.isFile()
      && metadata.size > 2
      && metadata.size <= MAX_AUTH_FILE_BYTES;
  } catch (error: unknown) {
    if (!isMissing(error)) {
      console.warn(`[coding-agents] ${harness} native auth metadata unavailable`);
    }
    return false;
  }
}
