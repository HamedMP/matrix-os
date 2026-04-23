import { lstat, readFile, realpath, stat } from "node:fs/promises";
import type { Context } from "hono";
import { isAbsolute, join, relative } from "node:path";
import { resolveWithinHome } from "../path-security.js";

const TEXT_MIME_TYPES: Record<string, string> = {
  html: "text/html",
  json: "application/json",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  md: "text/markdown",
  txt: "text/plain",
  svg: "image/svg+xml",
  xml: "application/xml",
  wasm: "application/wasm",
};

const BINARY_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  otf: "font/otf",
};

const MAX_STATIC_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB
type FileStat = Awaited<ReturnType<typeof stat>>;

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function statSize(fileStat: FileStat): number {
  if (typeof fileStat.size === "bigint") {
    return fileStat.size > BigInt(MAX_STATIC_ASSET_SIZE)
      ? MAX_STATIC_ASSET_SIZE + 1
      : Number(fileStat.size);
  }
  return fileStat.size;
}

async function resolveExistingFileWithin(
  baseDir: string,
  requestPath: string,
): Promise<
  | { ok: true; path: string; stat: FileStat }
  | { ok: false; status: 403 | 404 }
> {
  const fullPath = resolveWithinHome(baseDir, requestPath);
  if (fullPath === null) {
    return { ok: false, status: 403 };
  }

  let linkStat;
  try {
    linkStat = await lstat(fullPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404 };
    }
    throw err;
  }

  if (linkStat.isSymbolicLink()) {
    return { ok: false, status: 403 };
  }

  const [baseReal, targetReal] = await Promise.all([
    realpath(baseDir),
    realpath(fullPath),
  ]);
  if (!isWithin(baseReal, targetReal)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, path: targetReal, stat: await stat(targetReal) };
}

async function readCappedFile(
  path: string,
  size: number,
  c: Context,
): Promise<Uint8Array<ArrayBuffer> | Response> {
  if (size > MAX_STATIC_ASSET_SIZE) {
    return c.text("Payload too large", 413);
  }
  return Uint8Array.from(await readFile(path));
}

export async function serveStaticFileWithin(
  baseDir: string,
  requestPath: string,
  c: Context,
): Promise<Response> {
  // SPA fallback: empty path or directory -> index.html
  let filePath = requestPath;
  if (filePath === "" || filePath === "/") {
    filePath = "index.html";
  }

  // Strip leading slash
  if (filePath.startsWith("/")) {
    filePath = filePath.slice(1);
  }

  const resolved = await resolveExistingFileWithin(baseDir, filePath);
  if (!resolved.ok && resolved.status === 403) {
    return c.text("Forbidden", 403);
  }
  if (!resolved.ok) {
    // SPA fallback: non-existing paths serve index.html
    const index = await resolveExistingFileWithin(baseDir, "index.html");
    if (index.ok && index.stat.isFile()) {
      const content = await readCappedFile(index.path, statSize(index.stat), c);
      if (content instanceof Response) return content;
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  if (resolved.stat.isDirectory()) {
    const index = await resolveExistingFileWithin(baseDir, join(filePath, "index.html"));
    if (index.ok && index.stat.isFile()) {
      const content = await readCappedFile(index.path, statSize(index.stat), c);
      if (content instanceof Response) return content;
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  if (!resolved.stat.isFile()) {
    return c.text("Not found", 404);
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  if (BINARY_MIME_TYPES[ext]) {
    const etag = `"${resolved.stat.mtimeMs.toString(36)}-${resolved.stat.size.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }
    const buffer = await readCappedFile(resolved.path, statSize(resolved.stat), c);
    if (buffer instanceof Response) return buffer;
    return c.body(buffer, 200, {
      "Content-Type": BINARY_MIME_TYPES[ext],
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: etag,
    });
  }

  const content = await readCappedFile(resolved.path, statSize(resolved.stat), c);
  if (content instanceof Response) return content;
  return c.body(content, 200, {
    "Content-Type": TEXT_MIME_TYPES[ext] ?? "application/octet-stream",
  });
}
