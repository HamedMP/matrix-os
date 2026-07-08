import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  FileReadRequestSchema,
  FileReadResponseSchema,
  type FileReadRequest,
  type FileReadResponse,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";

const DEFAULT_FILE_READ_LIMIT_BYTES = 64 * 1024;

type FileReadErrorCode = "file_not_found" | "not_file" | "file_unavailable";

export class CodingAgentFileReadError extends Error {
  constructor(public readonly code: FileReadErrorCode) {
    super(code);
  }
}

export interface CodingAgentFileStore {
  readFile(principal: RequestPrincipal, request: FileReadRequest): Promise<FileReadResponse>;
}

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canReadFiles(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
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

function etagFor(input: { size: number; mtimeMs: number; content: Buffer }): string {
  const digest = createHash("sha256")
    .update(String(input.size))
    .update(":")
    .update(String(Math.trunc(input.mtimeMs)))
    .update(":")
    .update(input.content)
    .digest("hex")
    .slice(0, 48);
  return `sha256_${digest}`;
}

function fsErrorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
}

export function createCodingAgentFileStore(options: {
  homePath: string;
  ownerId?: string;
  principalOwnerIds?: readonly string[];
  readLimitBytes?: number;
}): CodingAgentFileStore {
  const homePath = resolve(options.homePath);
  const ownerIds = ownerIdsFor(options);
  const readLimitBytes = Math.max(1, Math.min(options.readLimitBytes ?? DEFAULT_FILE_READ_LIMIT_BYTES, DEFAULT_FILE_READ_LIMIT_BYTES));

  return {
    async readFile(principal, rawRequest) {
      if (!canReadFiles(principal, ownerIds)) {
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
            etag: etagFor({ size: stats.size, mtimeMs: stats.mtimeMs, content: contentBuffer }),
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
  };
}
