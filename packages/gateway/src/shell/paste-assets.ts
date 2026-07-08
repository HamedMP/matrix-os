import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { SESSION_NAME_PATTERN } from "./names.js";

export const TERMINAL_PASTE_ASSET_ROOT = "projects/.matrix-terminal-pastes";
export const TERMINAL_PASTE_ASSET_FIELD = "asset";
export const TERMINAL_PASTE_ASSET_TRANSACTION_FIELD = "transactionId";
export const TERMINAL_PASTE_ASSET_MAX_FILES = 5;
export const TERMINAL_PASTE_ASSET_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TERMINAL_PASTE_ASSET_BODY_LIMIT_BYTES = 52 * 1024 * 1024;
export const TERMINAL_PASTE_ASSET_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TERMINAL_PASTE_ASSET_DEFAULT_MAX_FILES_PER_SESSION = 200;
export const TERMINAL_PASTE_ASSET_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const TERMINAL_PASTE_IMAGE_TYPES = {
  png: {
    mimeType: "image/png",
    extension: ".png",
  },
  jpeg: {
    mimeType: "image/jpeg",
    extension: ".jpg",
  },
  gif: {
    mimeType: "image/gif",
    extension: ".gif",
  },
  webp: {
    mimeType: "image/webp",
    extension: ".webp",
  },
} as const;

export type TerminalPasteAssetMimeType =
  (typeof TERMINAL_PASTE_IMAGE_TYPES)[keyof typeof TERMINAL_PASTE_IMAGE_TYPES]["mimeType"];

export type TerminalPasteAssetErrorCode =
  | "invalid_request"
  | "payload_too_large"
  | "session_not_found"
  | "write_failed";

export interface TerminalPasteAssetCleanupPolicy {
  maxAgeMs: number;
  maxAssetsPerSession: number;
  cleanupIntervalMs: number;
}

export interface TerminalPasteAssetUploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface TerminalPasteAssetUploadInput {
  sessionName: string;
  transactionId?: string;
  files: TerminalPasteAssetUploadFile[];
}

export interface StoredTerminalPasteAsset {
  assetId: string;
  path: string;
  homeRelativePath: string;
  mimeType: TerminalPasteAssetMimeType;
  size: number;
}

export interface TerminalPasteAssetUploadResult {
  assets: StoredTerminalPasteAsset[];
}

export interface TerminalPasteAssetService {
  upload(input: TerminalPasteAssetUploadInput): Promise<TerminalPasteAssetUploadResult>;
  sweepExpired(): Promise<void>;
  close(): void;
}

export interface TerminalPasteAssetServiceOptions {
  homePath: string;
  cleanupPolicy?: Partial<TerminalPasteAssetCleanupPolicy>;
  now?: () => Date;
}

export class TerminalPasteAssetError extends Error {
  readonly code: TerminalPasteAssetErrorCode;
  readonly status: 400 | 413 | 404 | 500;

  constructor(code: TerminalPasteAssetErrorCode, status: 400 | 413 | 404 | 500) {
    super("Request failed");
    this.name = "TerminalPasteAssetError";
    this.code = code;
    this.status = status;
  }
}

export function createTerminalPasteAssetError(
  code: TerminalPasteAssetErrorCode,
  status: 400 | 413 | 404 | 500,
): TerminalPasteAssetError {
  return new TerminalPasteAssetError(code, status);
}

export function createTerminalPasteAssetService(
  options: TerminalPasteAssetServiceOptions,
): TerminalPasteAssetService {
  return new DefaultTerminalPasteAssetService(options);
}

class DefaultTerminalPasteAssetService implements TerminalPasteAssetService {
  readonly homePath: string;
  readonly cleanupPolicy: TerminalPasteAssetCleanupPolicy;
  readonly now: () => Date;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TerminalPasteAssetServiceOptions) {
    this.homePath = options.homePath;
    this.cleanupPolicy = {
      maxAgeMs: options.cleanupPolicy?.maxAgeMs ?? TERMINAL_PASTE_ASSET_DEFAULT_MAX_AGE_MS,
      maxAssetsPerSession:
        options.cleanupPolicy?.maxAssetsPerSession ?? TERMINAL_PASTE_ASSET_DEFAULT_MAX_FILES_PER_SESSION,
      cleanupIntervalMs:
        options.cleanupPolicy?.cleanupIntervalMs ?? TERMINAL_PASTE_ASSET_CLEANUP_INTERVAL_MS,
    };
    this.now = options.now ?? (() => new Date());
    if (this.cleanupPolicy.cleanupIntervalMs > 0) {
      void this.sweepExpired().catch((err: unknown) => {
        logCleanupFailure(err);
      });
      this.cleanupTimer = setInterval(() => {
        void this.sweepExpired().catch((err: unknown) => {
          logCleanupFailure(err);
        });
      }, this.cleanupPolicy.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  async upload(input: TerminalPasteAssetUploadInput): Promise<TerminalPasteAssetUploadResult> {
    if (!SESSION_NAME_PATTERN.test(input.sessionName) || !isSafeTransactionId(input.transactionId)) {
      throw createTerminalPasteAssetError("invalid_request", 400);
    }
    if (input.files.length < 1 || input.files.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
      throw createTerminalPasteAssetError("invalid_request", 400);
    }

    const assets: StoredTerminalPasteAsset[] = [];
    const dateSegment = this.now().toISOString().slice(0, 10);
    const homeRelativeDirectory = [
      TERMINAL_PASTE_ASSET_ROOT,
      input.sessionName,
      dateSegment,
    ].join("/");
    const targetDirectory = join(this.homePath, homeRelativeDirectory);

    for (const file of input.files) {
      if (file.size > TERMINAL_PASTE_ASSET_MAX_FILE_BYTES) {
        throw createTerminalPasteAssetError("payload_too_large", 413);
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.byteLength < 1) {
        throw createTerminalPasteAssetError("invalid_request", 400);
      }
      if (bytes.byteLength > TERMINAL_PASTE_ASSET_MAX_FILE_BYTES) {
        throw createTerminalPasteAssetError("payload_too_large", 413);
      }
      const imageType = detectImageType(bytes);
      if (!imageType) {
        throw createTerminalPasteAssetError("invalid_request", 400);
      }

      const assetId = `paste_${randomUUID().replaceAll("-", "")}`;
      const filename = `${assetId}${imageType.extension}`;
      const homeRelativePath = `${homeRelativeDirectory}/${filename}`;
      const destinationPath = join(this.homePath, homeRelativePath);
      const tmpPath = join(targetDirectory, `.${filename}.${randomUUID()}.tmp`);

      try {
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        await writeFile(tmpPath, bytes, { flag: "wx", mode: 0o600 });
        await rename(tmpPath, destinationPath);
      } catch (err: unknown) {
        await safeUnlink(tmpPath);
        console.warn("[shell] terminal paste asset write failed:", err instanceof Error ? err.message : String(err));
        throw createTerminalPasteAssetError("write_failed", 500);
      }

      assets.push({
        assetId,
        path: destinationPath,
        homeRelativePath,
        mimeType: imageType.mimeType,
        size: bytes.byteLength,
      });
    }

    return { assets };
  }

  async sweepExpired(): Promise<void> {
    const root = join(this.homePath, TERMINAL_PASTE_ASSET_ROOT);
    const files = await collectCleanupFiles(root);
    const retainedBySession: Record<string, CleanupFile[]> = Object.create(null);
    const nowMs = this.now().getTime();

    for (const file of files) {
      if (nowMs - file.mtimeMs > this.cleanupPolicy.maxAgeMs) {
        await safeUnlink(file.path);
        continue;
      }
      const sessionName = relative(root, file.path).split(/[\\/]/)[0];
      if (!sessionName || !SESSION_NAME_PATTERN.test(sessionName)) {
        continue;
      }
      retainedBySession[sessionName] = retainedBySession[sessionName] ?? [];
      retainedBySession[sessionName].push(file);
    }

    for (const retained of Object.values(retainedBySession)) {
      retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const stale of retained.slice(this.cleanupPolicy.maxAssetsPerSession)) {
        await safeUnlink(stale.path);
      }
    }
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

interface CleanupFile {
  path: string;
  mtimeMs: number;
}

async function collectCleanupFiles(directory: string): Promise<CleanupFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const files: CleanupFile[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    let stats;
    try {
      stats = await lstat(entryPath);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw err;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      files.push(...await collectCleanupFiles(entryPath));
      continue;
    }
    if (stats.isFile()) {
      files.push({ path: entryPath, mtimeMs: stats.mtimeMs });
    }
  }
  return files;
}

function isSafeTransactionId(value: string | undefined): boolean {
  return value === undefined || /^[a-zA-Z0-9_.:-]{1,80}$/.test(value);
}

function detectImageType(bytes: Uint8Array): {
  mimeType: TerminalPasteAssetMimeType;
  extension: string;
} | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return TERMINAL_PASTE_IMAGE_TYPES.png;
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return TERMINAL_PASTE_IMAGE_TYPES.jpeg;
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return TERMINAL_PASTE_IMAGE_TYPES.gif;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return TERMINAL_PASTE_IMAGE_TYPES.webp;
  }
  return null;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    console.warn("[shell] terminal paste temp cleanup failed:", err instanceof Error ? err.message : String(err));
  }
}

function logCleanupFailure(err: unknown): void {
  console.warn("[shell] terminal paste cleanup failed:", err instanceof Error ? err.message : String(err));
}
