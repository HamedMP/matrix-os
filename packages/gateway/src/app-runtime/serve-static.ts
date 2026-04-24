import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import type { Context } from "hono";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { resolveWithinHome } from "../path-security.js";

const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;

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

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isWithinRealPath(baseReal: string, candidateReal: string): boolean {
  return candidateReal === baseReal || candidateReal.startsWith(`${baseReal}${sep}`);
}

async function resolveEntry(baseDir: string, baseReal: string, path: string) {
  const fullPath = resolveWithinHome(baseDir, path);
  if (fullPath === null) {
    return { status: "forbidden" as const };
  }

  const fileStat = await lstatOrNull(fullPath);
  if (!fileStat) {
    return { status: "missing" as const };
  }
  if (fileStat.isSymbolicLink()) {
    return { status: "forbidden" as const };
  }

  const real = await realpath(fullPath);
  if (!isWithinRealPath(baseReal, real)) {
    return { status: "forbidden" as const };
  }

  return { status: "found" as const, fullPath, fileStat };
}

function serveFile(
  fullPath: string,
  requestPath: string,
  fileStat: Awaited<ReturnType<typeof lstat>>,
  c: Context,
): Response {
  if (fileStat.size > MAX_STATIC_ASSET_BYTES) {
    return c.text("Payload too large", 413);
  }

  const ext = requestPath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = BINARY_MIME_TYPES[ext] ?? TEXT_MIME_TYPES[ext] ?? "application/octet-stream";
  const etag = `"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;

  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304);
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ETag: etag,
  };
  if (BINARY_MIME_TYPES[ext]) {
    headers["Cache-Control"] = "public, max-age=86400, immutable";
  }

  const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers });
}

export async function serveStaticFileWithin(
  baseDir: string,
  requestPath: string,
  c: Context,
): Promise<Response> {
  let baseReal: string;
  try {
    baseReal = await realpath(baseDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return c.text("Not found", 404);
    }
    throw err;
  }

  // SPA fallback: empty path or directory -> index.html
  let filePath = requestPath;
  if (filePath === "" || filePath === "/") {
    filePath = "index.html";
  }

  // Strip leading slash
  if (filePath.startsWith("/")) {
    filePath = filePath.slice(1);
  }

  const entry = await resolveEntry(baseDir, baseReal, filePath);
  if (entry.status === "forbidden") {
    return c.text("Forbidden", 403);
  }

  if (entry.status === "missing") {
    // SPA fallback: non-existing paths serve index.html
    const indexEntry = await resolveEntry(baseDir, baseReal, "index.html");
    if (indexEntry.status === "forbidden") {
      return c.text("Forbidden", 403);
    }
    if (indexEntry.status === "found" && indexEntry.fileStat.isFile()) {
      return serveFile(indexEntry.fullPath, "index.html", indexEntry.fileStat, c);
    }
    return c.text("Not found", 404);
  }

  const { fullPath, fileStat } = entry;
  if (fileStat.isDirectory()) {
    const indexEntry = await resolveEntry(baseDir, baseReal, join(filePath, "index.html"));
    if (indexEntry.status === "forbidden") {
      return c.text("Forbidden", 403);
    }
    if (indexEntry.status === "found" && indexEntry.fileStat.isFile()) {
      return serveFile(indexEntry.fullPath, join(filePath, "index.html"), indexEntry.fileStat, c);
    }
    return c.text("Not found", 404);
  }

  if (!fileStat.isFile()) {
    return c.text("Not found", 404);
  }

  return serveFile(fullPath, filePath, fileStat, c);
}
