import type { R2Client } from "./r2-client.js";
import { buildFileKey } from "./r2-client.js";
import { resolveWithinPrefix } from "./path-validation.js";
import type { PresignFile } from "./types.js";

const PRESIGN_EXPIRY_SECONDS = 900; // 15 minutes
const SINGLE_PUT_MAX = 100 * 1024 * 1024; // 100MB -- above this, use multipart
const MAX_PUT_SIZE = 1024 * 1024 * 1024; // 1GB hard cap
const MULTIPART_PART_SIZE = 64 * 1024 * 1024; // 64MB per part

export interface PresignDeps {
  r2: R2Client;
}

export interface MultipartInfo {
  uploadId: string;
  partUrls: string[];
  partSize: number;
}

export interface PresignResult {
  path: string;
  url: string;
  expiresIn: number;
  multipart?: MultipartInfo;
}

export class PresignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresignValidationError";
  }
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
      throw new PresignValidationError(
        `Invalid path "${file.path}": ${validation.reason}`,
      );
    }
  }

  // Validate sizes for PUT actions
  for (const file of files) {
    if (file.action === "put" && typeof file.size !== "number") {
      throw new PresignValidationError(
        `File "${file.path}" must include size for PUT`,
      );
    }
    if (file.action === "put" && (file.size <= 0 || file.size > MAX_PUT_SIZE)) {
      throw new PresignValidationError(
        `File "${file.path}" must have size between 1 byte and 1GB (${file.size} bytes)`,
      );
    }
  }

  const results: PresignResult[] = [];

  for (const file of files) {
    const key = buildFileKey(userId, file.path);

    if (file.action === "get") {
      const url = await deps.r2.getPresignedGetUrl(key, PRESIGN_EXPIRY_SECONDS);
      results.push({ path: file.path, url, expiresIn: PRESIGN_EXPIRY_SECONDS });
    } else if (file.action === "put" && file.size > SINGLE_PUT_MAX) {
      // Multipart upload for files >100MB
      const uploadId = await deps.r2.createMultipartUpload(key);
      const partCount = Math.ceil(file.size / MULTIPART_PART_SIZE);
      const partUrls: string[] = [];

      for (let i = 1; i <= partCount; i++) {
        const partUrl = await deps.r2.getPresignedPartUrl(
          key, uploadId, i, PRESIGN_EXPIRY_SECONDS,
        );
        partUrls.push(partUrl);
      }

      results.push({
        path: file.path,
        url: "", // no single PUT URL for multipart
        expiresIn: PRESIGN_EXPIRY_SECONDS,
        multipart: { uploadId, partUrls, partSize: MULTIPART_PART_SIZE },
      });
    } else {
      const url = await deps.r2.getPresignedPutUrl(
        key,
        file.size,
        PRESIGN_EXPIRY_SECONDS,
      );
      results.push({ path: file.path, url, expiresIn: PRESIGN_EXPIRY_SECONDS });
    }
  }

  return results;
}
