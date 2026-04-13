import type { R2Client } from "./r2-client.js";
import { buildFileKey } from "./r2-client.js";
import { resolveWithinPrefix } from "./path-validation.js";
import type { PresignFile } from "./types.js";

const PRESIGN_EXPIRY_SECONDS = 900; // 15 minutes
const MAX_PUT_SIZE = 100 * 1024 * 1024; // 100MB

export interface PresignDeps {
  r2: R2Client;
}

export interface PresignResult {
  path: string;
  url: string;
  expiresIn: number;
}

export async function generatePresignedUrls(
  deps: PresignDeps,
  userId: string,
  files: PresignFile[],
): Promise<PresignResult[]> {
  // Validate all paths first
  for (const file of files) {
    const validation = resolveWithinPrefix(userId, file.path);
    if (!validation.valid) {
      throw new Error(`Invalid path "${file.path}": ${validation.reason}`);
    }
  }

  // Validate sizes for PUT actions
  for (const file of files) {
    if (file.action === "put" && file.size != null && file.size > MAX_PUT_SIZE) {
      throw new Error(
        `File "${file.path}" exceeds maximum size of 100MB (${file.size} bytes)`,
      );
    }
  }

  const results: PresignResult[] = [];

  for (const file of files) {
    const key = buildFileKey(userId, file.path);
    let url: string;

    if (file.action === "get") {
      url = await deps.r2.getPresignedGetUrl(key, PRESIGN_EXPIRY_SECONDS);
    } else {
      url = await deps.r2.getPresignedPutUrl(key, PRESIGN_EXPIRY_SECONDS);
    }

    results.push({
      path: file.path,
      url,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }

  return results;
}
