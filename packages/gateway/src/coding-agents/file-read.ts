import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  type FileReadRequest,
  type FileReadResponse,
  type FileWriteRequest,
  type FileWriteResponse,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";

const DEFAULT_FILE_READ_LIMIT_BYTES = 64 * 1024;
const DEFAULT_FILE_WRITE_LIMIT_BYTES = 64 * 1024;
const MAX_FILE_ETAG_BYTES = 100 * 1024 * 1024;
const MAX_FILE_WRITE_LOCKS = 256;

type FileReadErrorCode = "file_not_found" | "not_file" | "file_unavailable";
type FileWriteErrorCode = "file_not_found" | "not_file" | "file_conflict" | "invalid_request" | "file_unavailable";

export class CodingAgentFileReadError extends Error {
  constructor(public readonly code: FileReadErrorCode) {
    super(code);
  }
}

export class CodingAgentFileWriteError extends Error {
  constructor(public readonly code: FileWriteErrorCode) {
    super(code);
  }
}

export interface CodingAgentFileStore {
  readFile(principal: RequestPrincipal, request: FileReadRequest): Promise<FileReadResponse>;
  writeFile(principal: RequestPrincipal, request: FileWriteRequest): Promise<FileWriteResponse>;
}

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canAccessFiles(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function worktreeRootFor(homePath: string, request: FileReadRequest): string {
  return resolve(homePath, "projects", request.projectId, "worktrees", request.worktreeId);
}

function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join("/");
}

function etagDigest(input: { size: number; mtimeMs: number; hash: ReturnType<typeof createHash> }): string {
  const digest = input.hash
    .digest("hex")
    .slice(0, 48);
  return `sha256_${digest}`;
}

function fsErrorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
}

async function safeUnlinkTemp(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (fsErrorCode(err) !== "ENOENT") {
      console.warn("[coding-agents] file write temp cleanup failed");
    }
  }
}

async function fileEtagFor(path: string, stats: Awaited<ReturnType<typeof lstat>>): Promise<string> {
  const size = Number(stats.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_ETAG_BYTES) {
    throw new CodingAgentFileWriteError("file_unavailable");
  }
  const handle = await open(path, "r").catch((err: unknown) => {
    const code = fsErrorCode(err);
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
      throw new CodingAgentFileWriteError("file_conflict");
    }
    throw err;
  });
  try {
    const hash = createHash("sha256")
      .update(String(size))
      .update(":")
      .update(String(Math.trunc(Number(stats.mtimeMs))))
      .update(":");
    const readBuffer = Buffer.alloc(64 * 1024);
    let totalBytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      const readSize = Number(bytesRead);
      if (readSize === 0) break;
      totalBytes += readSize;
      if (totalBytes > MAX_FILE_ETAG_BYTES) {
        throw new CodingAgentFileWriteError("file_unavailable");
      }
      hash.update(readBuffer.subarray(0, readSize));
    }
    return etagDigest({ size, mtimeMs: Number(stats.mtimeMs), hash });
  } finally {
    await handle.close();
  }
}

async function readComparableContent(path: string, expectedBytes: number): Promise<Buffer> {
  const handle = await open(path, "r").catch((err: unknown) => {
    const code = fsErrorCode(err);
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
      throw new CodingAgentFileWriteError("file_conflict");
    }
    throw err;
  });
  try {
    const readBuffer = Buffer.alloc(expectedBytes + 1);
    const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, 0);
    return readBuffer.subarray(0, Number(bytesRead));
  } finally {
    await handle.close();
  }
}

async function fileWriteResponseFor(input: {
  path: string;
  requestPath: string;
  contentBytes: number;
  stats: Awaited<ReturnType<typeof lstat>>;
}): Promise<FileWriteResponse> {
  return FileWriteResponseSchema.parse({
    metadata: {
      path: normalizePath(input.requestPath),
      kind: "file",
      sizeBytes: Number(input.stats.size),
      etag: await fileEtagFor(input.path, input.stats),
      updatedAt: input.stats.mtime.toISOString(),
    },
    encoding: "utf8",
    writtenBytes: input.contentBytes,
  });
}

function settleFileWriteLockError(_err: unknown): void {
  console.warn("[coding-agents] file write lock queue recovered");
}

async function withFileWriteLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key);
  if (!previous && locks.size >= MAX_FILE_WRITE_LOCKS) {
    throw new CodingAgentFileWriteError("file_unavailable");
  }
  let release!: () => void;
  const releasePromise = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const tail = previous ? previous.catch(settleFileWriteLockError).then(() => releasePromise) : releasePromise;
  locks.set(key, tail);
  await previous?.catch(settleFileWriteLockError);
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

export function createCodingAgentFileStore(options: {
  homePath: string;
  ownerId?: string;
  principalOwnerIds?: readonly string[];
  readLimitBytes?: number;
  writeLimitBytes?: number;
}): CodingAgentFileStore {
  const homePath = resolve(options.homePath);
  const ownerIds = ownerIdsFor(options);
  const readLimitBytes = Math.max(1, Math.min(options.readLimitBytes ?? DEFAULT_FILE_READ_LIMIT_BYTES, DEFAULT_FILE_READ_LIMIT_BYTES));
  const writeLimitBytes = Math.max(1, Math.min(options.writeLimitBytes ?? DEFAULT_FILE_WRITE_LIMIT_BYTES, DEFAULT_FILE_WRITE_LIMIT_BYTES));
  const writeLocks = new Map<string, Promise<void>>();

  return {
    async readFile(principal, rawRequest) {
      if (!canAccessFiles(principal, ownerIds)) {
        throw new CodingAgentFileReadError("file_not_found");
      }
      const request = FileReadRequestSchema.parse(rawRequest);
      const worktreeRoot = worktreeRootFor(homePath, request);
      const target = resolve(worktreeRoot, request.path);
      if (!isWithin(worktreeRoot, target)) {
        throw new CodingAgentFileReadError("file_not_found");
      }

      let rootReal: string;
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        rootReal = await realpath(worktreeRoot);
        stats = await lstat(target);
      } catch (err: unknown) {
        const code = fsErrorCode(err);
        if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
          throw new CodingAgentFileReadError("file_not_found");
        }
        console.warn("[coding-agents] file read stat failed");
        throw new CodingAgentFileReadError("file_unavailable");
      }

      if (stats.isSymbolicLink()) {
        throw new CodingAgentFileReadError("file_not_found");
      }
      if (!stats.isFile()) {
        throw new CodingAgentFileReadError("not_file");
      }

      let targetReal: string;
      try {
        targetReal = await realpath(target);
      } catch (err: unknown) {
        const code = fsErrorCode(err);
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
          console.warn("[coding-agents] file read realpath failed");
        }
        throw new CodingAgentFileReadError("file_not_found");
      }
      if (!isWithin(rootReal, targetReal)) {
        throw new CodingAgentFileReadError("file_not_found");
      }

      const handle = await open(targetReal, "r").catch((err: unknown) => {
        const code = fsErrorCode(err);
        if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
          throw new CodingAgentFileReadError("file_not_found");
        }
        throw err;
      });
      try {
        const readBuffer = Buffer.alloc(readLimitBytes + 1);
        const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, 0);
        const truncated = bytesRead > readLimitBytes || stats.size > readLimitBytes;
        const contentBuffer = readBuffer.subarray(0, Math.min(bytesRead, readLimitBytes));
        const content = contentBuffer.toString("utf8");
        return FileReadResponseSchema.parse({
          metadata: {
            path: request.path.split(/[\\/]+/).join("/"),
            kind: "file",
            sizeBytes: stats.size,
            etag: await fileEtagFor(targetReal, stats),
            updatedAt: stats.mtime.toISOString(),
          },
          content,
          encoding: "utf8",
          truncated,
          limitBytes: readLimitBytes,
        });
      } catch (err: unknown) {
        if (err instanceof CodingAgentFileReadError) throw err;
        console.warn("[coding-agents] file read failed");
        throw new CodingAgentFileReadError("file_unavailable");
      } finally {
        await handle.close();
      }
    },

    async writeFile(principal, rawRequest) {
      if (!canAccessFiles(principal, ownerIds)) {
        throw new CodingAgentFileWriteError("file_not_found");
      }
      const request = FileWriteRequestSchema.parse(rawRequest);
      const contentBuffer = Buffer.from(request.content, "utf8");
      if (contentBuffer.byteLength > writeLimitBytes) {
        throw new CodingAgentFileWriteError("invalid_request");
      }
      const worktreeRoot = worktreeRootFor(homePath, request);
      const target = resolve(worktreeRoot, request.path);
      if (!isWithin(worktreeRoot, target)) {
        throw new CodingAgentFileWriteError("file_not_found");
      }

      let rootReal: string;
      let parentReal: string;
      try {
        rootReal = await realpath(worktreeRoot);
        parentReal = await realpath(dirname(target));
      } catch (err: unknown) {
        const code = fsErrorCode(err);
        if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
          throw new CodingAgentFileWriteError("file_not_found");
        }
        console.warn("[coding-agents] file write realpath failed");
        throw new CodingAgentFileWriteError("file_unavailable");
      }
      if (!isWithin(rootReal, parentReal)) {
        throw new CodingAgentFileWriteError("file_not_found");
      }
      const safeTarget = resolve(parentReal, basename(target));
      if (!isWithin(parentReal, safeTarget)) {
        throw new CodingAgentFileWriteError("file_not_found");
      }

      return withFileWriteLock(writeLocks, `${rootReal}:${safeTarget}`, async () => {
        let stats: Awaited<ReturnType<typeof lstat>> | null;
        try {
          stats = await lstat(safeTarget);
        } catch (err: unknown) {
          const code = fsErrorCode(err);
          if (code === "ENOENT") {
            stats = null;
          } else if (["ENOTDIR", "EACCES"].includes(code)) {
            throw new CodingAgentFileWriteError("file_not_found");
          } else {
            console.warn("[coding-agents] file write stat failed");
            throw new CodingAgentFileWriteError("file_unavailable");
          }
        }

        if (stats?.isSymbolicLink()) {
          throw new CodingAgentFileWriteError("file_not_found");
        }
        if (stats && !stats.isFile()) {
          throw new CodingAgentFileWriteError("not_file");
        }
        if (stats && request.baseEtag !== null && Number(stats.size) > readLimitBytes) {
          throw new CodingAgentFileWriteError("file_conflict");
        }

        const tempPath = resolve(parentReal, `.matrix-agent-write-${request.clientRequestId}-${randomUUID()}.tmp`);
        try {
          const tempMode = stats ? Number(stats.mode) & 0o7777 : 0o600;
          await writeFile(tempPath, contentBuffer, { flag: "wx", mode: tempMode });
          if (stats) {
            await chmod(tempPath, tempMode);
          }

          if (request.baseEtag === null) {
            if (stats) {
              const currentContent = await readComparableContent(safeTarget, contentBuffer.byteLength);
              if (!contentBuffer.equals(currentContent)) {
                throw new CodingAgentFileWriteError("file_conflict");
              }
              return fileWriteResponseFor({
                path: safeTarget,
                requestPath: request.path,
                contentBytes: contentBuffer.byteLength,
                stats,
              });
            }
            await link(tempPath, safeTarget).catch((err: unknown) => {
              const code = fsErrorCode(err);
              if (["EEXIST", "ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
                throw new CodingAgentFileWriteError(code === "EEXIST" ? "file_conflict" : "file_not_found");
              }
              throw err;
            });
          } else {
            if (!stats) throw new CodingAgentFileWriteError("file_conflict");
            const targetReal = await realpath(safeTarget).catch((err: unknown) => {
              const code = fsErrorCode(err);
              if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
                throw new CodingAgentFileWriteError("file_conflict");
              }
              throw err;
            });
            if (!isWithin(rootReal, targetReal)) {
              throw new CodingAgentFileWriteError("file_not_found");
            }
            const currentEtag = await fileEtagFor(targetReal, stats);
            if (currentEtag !== request.baseEtag) {
              const currentContent = await readComparableContent(targetReal, contentBuffer.byteLength);
              if (!contentBuffer.equals(currentContent)) {
                throw new CodingAgentFileWriteError("file_conflict");
              }
              const currentStats = await lstat(targetReal);
              return fileWriteResponseFor({
                path: targetReal,
                requestPath: request.path,
                contentBytes: contentBuffer.byteLength,
                stats: currentStats,
              });
            }
            await rename(tempPath, targetReal);
          }

          const nextStats = await lstat(safeTarget);
          if (!nextStats.isFile() || nextStats.isSymbolicLink()) {
            throw new CodingAgentFileWriteError("file_unavailable");
          }
          return fileWriteResponseFor({
            path: safeTarget,
            requestPath: request.path,
            contentBytes: contentBuffer.byteLength,
            stats: nextStats,
          });
        } catch (err: unknown) {
          if (err instanceof CodingAgentFileWriteError) throw err;
          console.warn("[coding-agents] file write failed");
          throw new CodingAgentFileWriteError("file_unavailable");
        } finally {
          await safeUnlinkTemp(tempPath);
        }
      });
    },
  };
}
