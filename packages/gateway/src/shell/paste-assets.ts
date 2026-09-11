import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveWritableFileApiPath } from "../path-security.js";
import { shellError } from "./errors.js";

export const TERMINAL_PASTE_ASSET_BODY_LIMIT = 10 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const SAFE_CLIENT_FILENAME = /^[^/\\\0]{1,255}$/;
const PASTE_ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_PASTE_ASSETS = 128;
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
export const TERMINAL_PASTE_ASSET_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = constants;
const DIRECTORY_OPEN_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;

interface PasteAssetKind {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  extension: ".png" | ".jpg" | ".gif" | ".webp";
}

export interface TerminalPasteAssetInput {
  homePath: string;
  cwd: string;
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
  now?: Date;
}

export interface TerminalPasteAssetResult {
  path: string;
  terminalPath: string;
  size: number;
  mimeType: string;
}

export interface TerminalPasteAssetCleanupLifecycle {
  runNow(): Promise<void>;
  waitForIdle(): Promise<void>;
  close(): void;
}

export function createTerminalPasteAssetCleanupLifecycle(options: {
  homePath: string;
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}): TerminalPasteAssetCleanupLifecycle {
  const intervalMs = options.intervalMs ?? TERMINAL_PASTE_ASSET_CLEANUP_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("InvalidTerminalPasteAssetCleanupInterval");
  }
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, ms) => setInterval(callback, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let closed = false;
  let inFlight: Promise<void> | null = null;

  const runNow = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    const cleanup = cleanupTerminalPasteAssets(options.homePath, now());
    inFlight = cleanup.then(
      () => { inFlight = null; },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };

  const handle = schedule(() => {
    void runNow().catch((error: unknown) => options.onError?.(error));
  }, intervalMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    const unref = (handle as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(handle);
  }

  return {
    runNow,
    async waitForIdle() { await inFlight; },
    close() {
      if (closed) return;
      closed = true;
      cancel(handle);
    },
  };
}

export async function saveTerminalPasteAsset(input: TerminalPasteAssetInput): Promise<TerminalPasteAssetResult> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > TERMINAL_PASTE_ASSET_BODY_LIMIT) {
    throw shellError("payload_too_large", "Request too large", 413);
  }
  validateClientFilename(input.filename);
  const declaredMime = normalizeContentType(input.contentType);
  if (declaredMime && !SUPPORTED_MIME_TYPES.has(declaredMime)) {
    throw shellError("unsupported_media_type", "Invalid request", 400);
  }
  const kind = detectPasteAssetKind(input.bytes);
  if (!kind || (declaredMime && declaredMime !== kind.mimeType)) {
    throw shellError("unsupported_media_type", "Invalid request", 400);
  }

  const now = input.now ?? new Date();
  const date = formatPasteAssetDate(now);
  const relativeDir = join("temporary", "terminal-pastes", date);
  const filename = `${Date.now()}-${randomUUID()}${kind.extension}`;
  const relativePath = join(relativeDir, filename);
  const absolutePath = resolveWritableFileApiPath(input.homePath, relativePath);
  if (!absolutePath) {
    throw shellError("invalid_request", "Invalid request", 400);
  }
  const absoluteDir = resolveWritableFileApiPath(input.homePath, relativeDir);
  if (!absoluteDir) {
    throw shellError("invalid_request", "Invalid request", 400);
  }

  await cleanupTerminalPasteAssets(input.homePath, now.getTime());
  await mkdir(absoluteDir, { recursive: true });
  const tempPath = join(absoluteDir, `.${filename}.tmp`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(input.bytes);
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, absolutePath);
  } catch (err: unknown) {
    await unlink(tempPath).catch((cleanupErr: unknown) => {
      console.warn(
        "[shell] failed to clean up terminal paste temp file:",
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      );
    });
    throw err;
  }

  return {
    path: relative(input.homePath, absolutePath).split(sep).join("/"),
    terminalPath: absolutePath,
    size: input.bytes.byteLength,
    mimeType: kind.mimeType,
  };
}

interface PinnedDirectory {
  handle: FileHandle;
  path: string;
}

async function openPinnedDirectory(path: string): Promise<PinnedDirectory | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, DIRECTORY_OPEN_FLAGS);
  } catch (error: unknown) {
    if (isMissing(error) || isUnsafeDirectory(error)) return null;
    throw error;
  }
  const pinnedPath = process.platform === "linux"
    ? `/proc/self/fd/${handle.fd}`
    : process.platform === "darwin" ? `/dev/fd/${handle.fd}` : path;
  return { handle, path: pinnedPath };
}

async function cleanupTerminalPasteAssets(homePath: string, nowMs: number): Promise<void> {
  const root = resolveWritableFileApiPath(homePath, join("temporary", "terminal-pastes"));
  if (!root) throw shellError("invalid_request", "Invalid request", 400);
  const pinnedHome = await openPinnedDirectory(homePath);
  if (!pinnedHome) return;
  let pinnedTemporary: PinnedDirectory | null = null;
  let pinnedRoot: PinnedDirectory | null = null;
  try {
    pinnedTemporary = await openPinnedDirectory(join(pinnedHome.path, "temporary"));
    if (!pinnedTemporary) return;
    pinnedRoot = await openPinnedDirectory(join(pinnedTemporary.path, "terminal-pastes"));
    if (!pinnedRoot) return;
    const retained: Array<{ path: string; mtimeMs: number; directory: PinnedDirectory }> = [];
    const retainedDirectories = new Set<PinnedDirectory>();
    try {
      for (const dateDirectory of await readdir(pinnedRoot.path)) {
        if (!DATE_DIRECTORY.test(dateDirectory)) continue;
        const pinnedDirectory = await openPinnedDirectory(join(pinnedRoot.path, dateDirectory));
        if (!pinnedDirectory) continue;
        try {
          for (const filename of await readdir(pinnedDirectory.path)) {
            const path = join(pinnedDirectory.path, filename);
            let stat;
            try { stat = await lstat(path); }
            catch (error: unknown) { if (isMissing(error)) continue; throw error; }
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            if (nowMs - stat.mtimeMs >= PASTE_ASSET_TTL_MS) {
              await unlinkIfPresent(path);
              continue;
            }
            retained.push({ path, mtimeMs: stat.mtimeMs, directory: pinnedDirectory });
            retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
            if (retained.length > MAX_RETAINED_PASTE_ASSETS - 1) {
              const evicted = retained.pop()!;
              await unlinkIfPresent(evicted.path);
              if (evicted.directory !== pinnedDirectory
                && !retained.some((candidate) => candidate.directory === evicted.directory)) {
                retainedDirectories.delete(evicted.directory);
                await evicted.directory.handle.close();
              }
            }
          }
          if (retained.some((candidate) => candidate.directory === pinnedDirectory)) {
            retainedDirectories.add(pinnedDirectory);
          } else {
            await pinnedDirectory.handle.close();
          }
        } catch (error: unknown) {
          if (!retainedDirectories.has(pinnedDirectory)) await pinnedDirectory.handle.close();
          throw error;
        }
      }
    } finally {
      await Promise.all([...retainedDirectories].map((directory) => directory.handle.close()));
    }
  } finally {
    if (pinnedRoot) await pinnedRoot.handle.close();
    if (pinnedTemporary) await pinnedTemporary.handle.close();
    await pinnedHome.handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error: unknown) { if (!isMissing(error)) throw error; }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnsafeDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "ELOOP" || error.code === "ENOTDIR");
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function validateClientFilename(filename: string | undefined): void {
  if (filename === undefined || filename === "") {
    return;
  }
  if (!SAFE_CLIENT_FILENAME.test(filename) || filename === "." || filename === "..") {
    throw shellError("invalid_request", "Invalid request", 400);
  }
}

function detectPasteAssetKind(bytes: Uint8Array): PasteAssetKind | null {
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
    return { mimeType: "image/png", extension: ".png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") {
      return { mimeType: "image/gif", extension: ".gif" };
    }
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") {
      return { mimeType: "image/webp", extension: ".webp" };
    }
  }
  return null;
}

function formatPasteAssetDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
