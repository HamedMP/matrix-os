import { readFile, stat } from "node:fs/promises";
import type { Context } from "hono";
import { join } from "node:path";
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

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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

  const fullPath = resolveWithinHome(baseDir, filePath);
  if (fullPath === null) {
    return c.text("Forbidden", 403);
  }

  const fileStat = await statOrNull(fullPath);

  if (!fileStat) {
    // SPA fallback: non-existing paths serve index.html
    const indexPath = join(baseDir, "index.html");
    const indexStat = await statOrNull(indexPath);
    if (indexStat?.isFile()) {
      const content = await readFile(indexPath, "utf-8");
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  if (fileStat.isDirectory()) {
    const indexPath = join(fullPath, "index.html");
    const indexStat = await statOrNull(indexPath);
    if (indexStat?.isFile()) {
      const content = await readFile(indexPath, "utf-8");
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  if (BINARY_MIME_TYPES[ext]) {
    const etag = `"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }
    const buffer = await readFile(fullPath);
    return c.body(buffer, 200, {
      "Content-Type": BINARY_MIME_TYPES[ext],
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: etag,
    });
  }

  const content = await readFile(fullPath, "utf-8");
  return c.body(content, 200, {
    "Content-Type": TEXT_MIME_TYPES[ext] ?? "application/octet-stream",
  });
}
