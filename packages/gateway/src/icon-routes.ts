import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Context, Hono } from "hono";
import { resolveBundledSystemIconPath, resolveSystemIconPath } from "./default-icons.js";
import { getMimeType } from "./file-utils.js";

type IconPathResolver = (homePath: string, requestedFile: string) => Promise<string | null>;

// ENOENT means the resolved icon vanished (regeneration race) -- a true 404.
// Anything else (EACCES, EMFILE, ...) is a server-side failure and must not
// masquerade as not-found; return a generic 500 and log the real error.
function iconReadErrorResponse(c: Context, err: unknown, operation: string) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    return c.text("Icon not found", 404);
  }
  console.warn(`[icons] failed to ${operation} resolved icon:`, err instanceof Error ? err.message : String(err));
  return c.text("Icon unavailable", 500);
}

// Icons must be served as bytes, never as redirects: an uncacheable 307 forces
// the browser to re-fetch every launcher icon through the whole proxy chain on
// each open. The `?v={etag}` query in icon URLs makes immutable caching safe.
function createIconHandler(homePath: string, resolveIconPath: IconPathResolver) {
  return async (c: Context) => {
    const file = c.req.param("file");
    if (!file) return c.text("Icon not found", 404);
    const target = await resolveIconPath(homePath, file);
    if (!target) return c.text("Icon not found", 404);
    let iconStat;
    try {
      iconStat = await stat(target);
    } catch (err) {
      return iconReadErrorResponse(c, err, "stat");
    }
    const etag = `"${iconStat.mtimeMs.toString(36)}-${iconStat.size.toString(36)}"`;
    const headers = {
      "Content-Type": getMimeType(extname(target)),
      "Cache-Control": "public, max-age=86400, immutable",
      "CDN-Cache-Control": "public, max-age=86400",
      "ETag": etag,
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    if (c.req.method === "HEAD") return c.body(null, 200, headers);
    let iconBody;
    try {
      iconBody = await readFile(target);
    } catch (err) {
      return iconReadErrorResponse(c, err, "read");
    }
    return c.body(iconBody, 200, headers);
  };
}

export function registerIconRoutes(app: Hono, homePath: string): void {
  const serveSystemIcon = createIconHandler(homePath, resolveSystemIconPath);
  app.on("HEAD", "/icons/:file", serveSystemIcon);
  app.get("/icons/:file", serveSystemIcon);

  const serveBundledSystemIcon = createIconHandler(homePath, resolveBundledSystemIconPath);
  app.on("HEAD", "/system-icons/:file", serveBundledSystemIcon);
  app.get("/system-icons/:file", serveBundledSystemIcon);
}
