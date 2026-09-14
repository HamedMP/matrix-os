import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import type { Context } from "hono";
import { FILE_DOWNLOAD_IDLE_TIMEOUT_MS, safeDownloadFilename } from "@matrix-os/contracts";
import { resolveExistingFileApiPath } from "./path-security.js";

export interface ByteRange { start: number; end: number }
export function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const length = Number(rawEnd);
    return Number.isSafeInteger(length) && length > 0 ? { start: Math.max(0, size - length), end: size - 1 } : null;
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export interface FileDownloadStreamOptions { maxConcurrent?: number; idleTimeoutMs?: number }
function attachmentDisposition(path: string): string {
  const filename = safeDownloadFilename(path);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
function unavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(String(error.code));
}

// Capacity is per Gateway/owner. Each response owns one file descriptor and one
// 64 KiB read at a time. Backpressure, cancellation, and idle cleanup bound both
// memory and descriptor lifetime without imposing a file-size or total-time cap.
export function createFileDownloadStream(homePath: string, options: FileDownloadStreamOptions = {}) {
  let active = 0;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const idleTimeoutMs = options.idleTimeoutMs ?? FILE_DOWNLOAD_IDLE_TIMEOUT_MS;
  return async (c: Context, path: string): Promise<Response> => {
    if (active >= maxConcurrent) return c.json({ error: "download_busy" }, 429);
    active += 1;
    let file: FileHandle | null = null;
    let handedOff = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
      clearTimeout(timer);
      if (onAbort) c.req.raw.signal.removeEventListener("abort", onAbort);
      try { await file?.close(); }
      catch (error: unknown) { console.warn("[file-download] source close failed", error); }
      finally { active -= 1; file = null; }
    })();

    try {
      const resolved = resolveExistingFileApiPath(homePath, path);
      if (!resolved) return c.json({ error: "not_found" }, 404);
      const canonical = await realpath(resolved);
      if (!resolveExistingFileApiPath(await realpath(homePath), canonical)) return c.json({ error: "not_found" }, 404);
      // Open once and stat the descriptor. A later unlink/rename cannot switch
      // the source; reject a last-component symlink or non-regular-file race.
      file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return c.json({ error: "not_file" }, 400);
      const size = Number(info.size);
      if (!Number.isSafeInteger(size)) return c.json({ error: "unavailable" }, 503);
      const etag = `"${info.dev.toString(16)}-${info.ino.toString(16)}-${info.size.toString(16)}-${info.mtimeNs.toString(16)}-${info.ctimeNs.toString(16)}"`;
      // Only an exact entity tag permits resumption; stale validators download
      // a complete new file instead of joining bytes from different versions.
      const requestedRange = c.req.header("range");
      const ifRange = c.req.header("if-range");
      const rangeHeader = !ifRange || ifRange === etag ? requestedRange : undefined;
      const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
      if (rangeHeader && !range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "private, no-store" } });
      let position = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": attachmentDisposition(path),
        "Content-Length": String(Math.max(0, end - position + 1)),
        "Accept-Ranges": "bytes", "ETag": etag,
        "Cache-Control": "private, no-store, no-transform", "X-Content-Type-Options": "nosniff",
      };
      if (range) headers["Content-Range"] = `bytes ${position}-${end}/${size}`;
      const status = range ? 206 : 200;
      if (c.req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
      const source = file;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          onAbort = () => {
            if (finished) return;
            finished = true;
            controller.error(new Error("Download interrupted"));
            void cleanup();
          };
          c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
          if (c.req.raw.signal.aborted) onAbort();
          else { timer = setTimeout(onAbort, idleTimeoutMs); timer.unref?.(); }
        },
        async pull(controller) {
          if (finished) return;
          clearTimeout(timer);
          timer = setTimeout(onAbort!, idleTimeoutMs);
          timer.unref?.();
          try {
            const buffer = new Uint8Array(Math.min(64 * 1024, end - position + 1));
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
            if (finished) return;
            if (bytesRead === 0) throw new Error("Download source ended early");
            position += bytesRead;
            if (position > end) {
              // Withhold the final chunk until the descriptor's version is
              // checked, so an in-place edit cannot finish as mixed content.
              const after = await source.stat({ bigint: true });
              if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) {
                throw new Error("Download source changed");
              }
              finished = true;
              await cleanup();
              controller.enqueue(buffer.subarray(0, bytesRead));
              controller.close();
            } else {
              controller.enqueue(buffer.subarray(0, bytesRead));
              clearTimeout(timer);
              timer = setTimeout(onAbort!, idleTimeoutMs);
              timer.unref?.();
            }
          } catch (error: unknown) {
            if (!finished) {
              console.warn("[file-download] source read failed", error);
              onAbort!();
            }
          }
        },
        async cancel() { finished = true; await cleanup(); },
      }, { highWaterMark: 0 });
      handedOff = true;
      return new Response(body, { status, headers });
    } catch (error: unknown) {
      if (unavailable(error)) return c.json({ error: "not_found" }, 404);
      console.warn("[file-download] source open failed", error);
      return c.json({ error: "download_failed" }, 500);
    } finally {
      if (!handedOff) await cleanup();
    }
  };
}
