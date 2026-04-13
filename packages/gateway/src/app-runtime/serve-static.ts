import { readFileSync, existsSync, statSync } from "node:fs";
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

export function serveStaticFileWithin(
  baseDir: string,
  requestPath: string,
  c: Context,
): Response {
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

  if (!existsSync(fullPath)) {
    // SPA fallback: non-existing paths serve index.html
    const indexPath = join(baseDir, "index.html");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  if (statSync(fullPath).isDirectory()) {
    // Try index.html within the directory
    const indexPath = join(fullPath, "index.html");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      return c.body(content, 200, {
        "Content-Type": "text/html",
      });
    }
    return c.text("Not found", 404);
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  if (BINARY_MIME_TYPES[ext]) {
    const fileStat = statSync(fullPath);
    const etag = `"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }
    const buffer = readFileSync(fullPath);
    return c.body(buffer, 200, {
      "Content-Type": BINARY_MIME_TYPES[ext],
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: etag,
    });
  }

  const content = readFileSync(fullPath, "utf-8");
  return c.body(content, 200, {
    "Content-Type": TEXT_MIME_TYPES[ext] ?? "application/octet-stream",
  });
}
