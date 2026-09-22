import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  FilePreviewDescriptorSchema,
  FileResourceRefSchema,
  classifyFilePreview,
  safeDownloadFilename,
  type FilePreviewDescriptor,
  type FileResourceRef,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "./request-principal.js";
import { getMimeType } from "./file-utils.js";
import { parseByteRange } from "./file-download-stream.js";
import { resolveExistingFileApiPath } from "./path-security.js";

const READ_CHUNK_BYTES = 64 * 1024;
const SNIFF_BYTES = 512;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

type ProjectResourceRef = Extract<FileResourceRef, { kind: "project" }>;
type ArtifactResourceRef = Extract<FileResourceRef, { kind: "artifact" }>;

export interface FilePreviewServiceOptions {
  homePath: string;
  canAccessHome(principal: RequestPrincipal): boolean;
  resolveProjectRoot(principal: RequestPrincipal, ref: ProjectResourceRef): Promise<string | null>;
  resolveArtifactPath?: (principal: RequestPrincipal, ref: ArtifactResourceRef) => Promise<string | null>;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
}

export class FilePreviewError extends Error {
  constructor(public readonly code: "not_found" | "unavailable" | "busy") {
    super(code);
  }
}

export interface FilePreviewService {
  resolvePreview(principal: RequestPrincipal, ref: FileResourceRef): Promise<FilePreviewDescriptor>;
  openPreviewContent(
    principal: RequestPrincipal,
    ref: FileResourceRef,
    options?: { range?: string; ifRange?: string; download?: boolean; head?: boolean; signal?: AbortSignal },
  ): Promise<Response>;
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fileErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function unavailableFileError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(fileErrorCode(error));
}

function versionFor(info: BigIntStats): string {
  return `file_${info.dev.toString(16)}_${info.ino.toString(16)}_${info.size.toString(16)}_${info.mtimeNs.toString(16)}_${info.ctimeNs.toString(16)}`;
}

function quotedEtag(version: string): string {
  return `"${version}"`;
}

function safeDisposition(name: string, download: boolean): string {
  const filename = safeDownloadFilename(name);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (value) =>
    `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function startsWithBytes(buffer: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((value, index) => buffer[index] === value);
}

function trustedMimeType(name: string, prefix: Uint8Array): { mimeType: string; rejectedDeclaredType: boolean } {
  const declared = getMimeType(extname(name));
  const checked = (matches: boolean) => ({
    mimeType: matches ? declared : "application/octet-stream",
    rejectedDeclaredType: !matches,
  });
  if (declared === "image/png") return checked(startsWithBytes(prefix, [137, 80, 78, 71, 13, 10, 26, 10]));
  if (declared === "image/jpeg") return checked(startsWithBytes(prefix, [0xff, 0xd8, 0xff]));
  if (declared === "image/gif") {
    const signature = Buffer.from(prefix.subarray(0, 6)).toString("ascii");
    return checked(signature === "GIF87a" || signature === "GIF89a");
  }
  if (declared === "image/webp") {
    return checked(Buffer.from(prefix.subarray(0, 4)).toString("ascii") === "RIFF"
      && Buffer.from(prefix.subarray(8, 12)).toString("ascii") === "WEBP");
  }
  if (declared === "image/svg+xml") {
    // SVG is active markup and may reference network resources. Keep it out of
    // the generic image renderer until a dedicated sanitizer/isolated viewer
    // can prove those references are inert.
    return { mimeType: "application/octet-stream", rejectedDeclaredType: true };
  }
  if (declared === "application/pdf") {
    return checked(Buffer.from(prefix.subarray(0, 5)).toString("ascii") === "%PDF-");
  }
  return { mimeType: declared, rejectedDeclaredType: false };
}

async function safeResolvedPath(
  options: FilePreviewServiceOptions,
  principal: RequestPrincipal,
  ref: FileResourceRef,
): Promise<{ path: string; root?: string }> {
  if (ref.kind === "home") {
    if (!options.canAccessHome(principal)) throw new FilePreviewError("not_found");
    const path = resolveExistingFileApiPath(options.homePath, ref.path);
    if (!path) throw new FilePreviewError("not_found");
    return { path };
  }
  if (ref.kind === "artifact") {
    const path = await options.resolveArtifactPath?.(principal, ref);
    if (!path || !isAbsolute(path)) throw new FilePreviewError("not_found");
    return { path };
  }
  const root = await options.resolveProjectRoot(principal, ref);
  if (!root) throw new FilePreviewError("not_found");
  const rootReal = await realpath(resolve(root)).catch((error: unknown) => {
    if (unavailableFileError(error)) throw new FilePreviewError("not_found");
    throw error;
  });
  const target = resolve(rootReal, ref.path);
  if (!isWithin(rootReal, target)) throw new FilePreviewError("not_found");
  try {
    const lexical = await lstat(target);
    if (lexical.isSymbolicLink() || !lexical.isFile()) throw new FilePreviewError("not_found");
    const targetReal = await realpath(target);
    if (!isWithin(rootReal, targetReal)) throw new FilePreviewError("not_found");
    return { path: targetReal, root: rootReal };
  } catch (error: unknown) {
    if (error instanceof FilePreviewError) throw error;
    if (unavailableFileError(error)) throw new FilePreviewError("not_found");
    throw error;
  }
}

async function openedPathIsAuthorized(path: string, info: BigIntStats, root?: string): Promise<boolean> {
  // The file descriptor is stable after open, but a writable parent can be
  // swapped between the initial realpath check and open(). Compare the file
  // actually opened with the path after open before reading any bytes.
  const currentPath = await realpath(path);
  if (root && !isWithin(root, currentPath)) return false;
  const current = await lstat(currentPath, { bigint: true });
  return current.isFile() && current.dev === info.dev && current.ino === info.ino;
}

async function openResolvedFile(
  options: FilePreviewServiceOptions,
  principal: RequestPrincipal,
  rawRef: FileResourceRef,
): Promise<{ ref: FileResourceRef; path: string; file: FileHandle; info: BigIntStats }> {
  const ref = FileResourceRefSchema.parse(rawRef);
  const { path, root } = await safeResolvedPath(options, principal, ref);
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || !await openedPathIsAuthorized(path, info, root)) {
      throw new FilePreviewError("not_found");
    }
    return { ref, path, file, info };
  } catch (error: unknown) {
    await file?.close();
    if (error instanceof FilePreviewError) throw error;
    if (unavailableFileError(error)) throw new FilePreviewError("not_found");
    throw new FilePreviewError("unavailable");
  }
}

async function descriptorFor(
  opened: Awaited<ReturnType<typeof openResolvedFile>>,
): Promise<FilePreviewDescriptor> {
  const size = Number(opened.info.size);
  if (!Number.isSafeInteger(size)) throw new FilePreviewError("unavailable");
  const sniff = new Uint8Array(Math.min(SNIFF_BYTES, size));
  if (sniff.length > 0) await opened.file.read(sniff, 0, sniff.length, 0);
  const name = basename(opened.path);
  const trusted = trustedMimeType(name, sniff);
  return FilePreviewDescriptorSchema.parse({
    resource: opened.ref,
    name,
    mimeType: trusted.mimeType,
    sizeBytes: size,
    kind: trusted.rejectedDeclaredType
      ? "unsupported"
      : classifyFilePreview({ name, mimeType: trusted.mimeType }),
    version: versionFor(opened.info),
    canDownload: true,
  });
}

export function createFilePreviewService(options: FilePreviewServiceOptions): FilePreviewService {
  let active = 0;
  const maxConcurrent = Math.max(1, Math.min(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 64));
  const idleTimeoutMs = Math.max(1_000, Math.min(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 5 * 60_000));

  return {
    async resolvePreview(principal, ref) {
      const opened = await openResolvedFile(options, principal, ref);
      try {
        return await descriptorFor(opened);
      } finally {
        await opened.file.close();
      }
    },

    async openPreviewContent(principal, ref, request = {}) {
      if (active >= maxConcurrent) throw new FilePreviewError("busy");
      active += 1;
      let opened: Awaited<ReturnType<typeof openResolvedFile>> | null = null;
      let handedOff = false;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let abort: (() => void) | undefined;
      const cleanup = () => cleanupPromise ??= (async () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort!);
        try { await opened?.file.close(); }
        catch (error: unknown) {
          console.warn("[file-preview] source close failed", error instanceof Error ? error.name : "UnknownError");
        }
        finally { opened = null; active -= 1; }
      })();

      try {
        opened = await openResolvedFile(options, principal, ref);
        const descriptor = await descriptorFor(opened);
        const size = descriptor.sizeBytes;
        const etag = quotedEtag(descriptor.version);
        const rangeHeader = !request.ifRange || request.ifRange === etag ? request.range : undefined;
        const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
        if (rangeHeader && !range) {
          return new Response(null, { status: 416, headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${size}`,
            "Cache-Control": "private, no-store, no-transform",
          } });
        }
        let position = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const headers: Record<string, string> = {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store, no-transform",
          "Content-Disposition": safeDisposition(descriptor.name, request.download ?? false),
          "Content-Length": String(Math.max(0, end - position + 1)),
          "Content-Type": descriptor.mimeType,
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        };
        if (range) headers["Content-Range"] = `bytes ${position}-${end}/${size}`;
        const status = range ? 206 : 200;
        if (request.head || size === 0) return new Response(null, { status, headers });
        const source = opened.file;
        const initialInfo = opened.info;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            abort = () => {
              if (finished) return;
              finished = true;
              controller.error(new Error("Preview interrupted"));
              void cleanup();
            };
            request.signal?.addEventListener("abort", abort, { once: true });
            if (request.signal?.aborted) abort();
            else { timer = setTimeout(abort, idleTimeoutMs); timer.unref?.(); }
          },
          async pull(controller) {
            if (finished) return;
            clearTimeout(timer);
            timer = setTimeout(abort!, idleTimeoutMs);
            timer.unref?.();
            try {
              const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, end - position + 1));
              const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
              if (finished) return;
              if (bytesRead === 0) throw new Error("Preview source ended early");
              position += bytesRead;
              if (position > end) {
                const after = await source.stat({ bigint: true });
                if (after.size !== initialInfo.size || after.mtimeNs !== initialInfo.mtimeNs || after.ctimeNs !== initialInfo.ctimeNs) {
                  throw new Error("Preview source changed");
                }
                finished = true;
                await cleanup();
                controller.enqueue(buffer.subarray(0, bytesRead));
                controller.close();
              } else {
                controller.enqueue(buffer.subarray(0, bytesRead));
              }
            } catch (error: unknown) {
              console.warn("[file-preview] source read failed", error instanceof Error ? error.name : "UnknownError");
              abort!();
            }
          },
          async cancel() {
            finished = true;
            await cleanup();
          },
        }, { highWaterMark: 0 });
        handedOff = true;
        return new Response(body, { status, headers });
      } finally {
        if (!handedOff) await cleanup();
      }
    },
  };
}
