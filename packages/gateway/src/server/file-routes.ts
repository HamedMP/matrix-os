import { existsSync, readFileSync, statSync } from "node:fs";
import {
  mkdir as mkdirAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isDeniedFileApiPath,
  resolveExistingFileApiPath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "../path-security.js";
import { listDirectory } from "../files-tree.js";
import { getMissingFileFallback } from "../file-fallbacks.js";
import { fileStat, fileMkdir, fileTouch, fileRename, fileCopy, fileDuplicate } from "../file-ops.js";
import { createFileBlobRoutes } from "../file-blob-routes.js";
import { fileSearch } from "../file-search.js";
import { fileDelete, trashList, trashRestore, trashEmpty } from "../trash.js";
import { listProjects } from "../projects.js";

export interface FileRouteDeps {
  homePath: string;
}

export function registerFileRoutes(app: Hono, deps: FileRouteDeps): void {
  const { homePath } = deps;
  const fileBodyLimit = bodyLimit({ maxSize: 10 * 1024 * 1024 });

  app.get("/api/files/tree", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json(result);
  });

  app.get("/api/files/list", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json({ path: pathParam, entries: result });
  });

  app.get("/api/files/stat", async (c) => {
    const pathParam = c.req.query("path");
    if (!pathParam) return c.json({ error: "path required" }, 400);
    const result = await fileStat(homePath, pathParam);
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  });

  app.get("/api/files/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q required" }, 400);
    if (q.length > 500) return c.json({ error: "q too long" }, 400);
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit) {
      limit = parseInt(rawLimit, 10);
      if (isNaN(limit) || limit < 1 || limit > 500) return c.json({ error: "limit must be 1-500" }, 400);
    }
    const result = await fileSearch(homePath, {
      q,
      path: c.req.query("path"),
      content: c.req.query("content") === "true",
      limit,
    });
    return c.json(result);
  });
  app.route("/api/files", createFileBlobRoutes({ homePath }));

  app.post("/api/files/mkdir", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileMkdir(homePath, body.path);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/api/files/touch", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string; content?: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileTouch(homePath, body.path, body.content);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/duplicate", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDuplicate(homePath, body.path);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/rename", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileRename(homePath, body.from, body.to);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/copy", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    const result = await fileCopy(homePath, body.from, body.to);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/delete", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    const result = await fileDelete(homePath, body.path);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.get("/api/files/trash", async (c) => {
    const result = await trashList(homePath);
    return c.json(result);
  });

  app.post("/api/files/trash/restore", fileBodyLimit, async (c) => {
    const body = await parseJson<{ trashPath: string }>(c);
    if (!body?.trashPath) return c.json({ error: "trashPath required" }, 400);
    const result = await trashRestore(homePath, body.trashPath);
    return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
  });

  app.post("/api/files/trash/empty", fileBodyLimit, async (c) => {
    const result = await trashEmpty(homePath);
    return c.json(result);
  });

  app.get("/api/projects", async (c) => {
    const rootParam = (c.req.query("root") ?? "projects").trim();
    const result = await listProjects(homePath, rootParam);
    if (!result.ok) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ root: result.root, projects: result.projects });
  });

  app.on("HEAD", "/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(homePath, filePath);
    if (!fullPath) return c.text("Forbidden", 403);
    if (!existsSync(fullPath)) {
      const fallback = getMissingFileFallback(filePath);
      if (fallback) return c.body(null, 200, { "content-type": fallback.contentType });
      return c.text("Not found", 404);
    }
    if (statSync(fullPath).isDirectory()) return c.text("Is a directory", 400);
    return c.body(null, 200);
  });

  app.get("/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(homePath, filePath);

    if (!fullPath) {
      return c.text("Forbidden", 403);
    }

    if (!existsSync(fullPath)) {
      const fallback = getMissingFileFallback(filePath);
      if (fallback) return c.body(fallback.body, 200, { "content-type": fallback.contentType });
      return c.text("Not found", 404);
    }

    if (statSync(fullPath).isDirectory()) {
      return c.text("Is a directory", 400);
    }

    const ext = filePath.split(".").pop() ?? "";

    const textMimeTypes: Record<string, string> = {
      html: "text/html",
      json: "application/json",
      js: "application/javascript",
      css: "text/css",
      md: "text/markdown",
      txt: "text/plain",
    };

    const imageMimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };

    if (imageMimeTypes[ext]) {
      const stat = statSync(fullPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304);
      }
      const buffer = readFileSync(fullPath);
      return c.body(buffer, 200, {
        "Content-Type": imageMimeTypes[ext],
        "Cache-Control": "public, max-age=86400, immutable",
        "CDN-Cache-Control": "public, max-age=86400",
        "ETag": etag,
      });
    }

    const content = readFileSync(fullPath, "utf-8");
    return c.body(content, 200, {
      "Content-Type": textMimeTypes[ext] ?? "text/plain",
    });
  });

  app.put("/files/*", fileBodyLimit, async (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWritableFileApiPath(homePath, filePath);
    if (!fullPath) return c.text("Invalid path", 403);
    const content = await c.req.text();
    const dir = dirname(fullPath);
    await mkdirAsync(dir, { recursive: true });
    await writeFileAsync(fullPath, content, "utf-8");
    return c.json({ ok: true });
  });
}

async function parseJson<T>(c: Parameters<MiddlewareHandler>[0]): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return null;
    }
    console.error("[gateway] Unexpected request JSON parse failure:", err);
    throw err;
  }
}

function resolveServedFilePath(homePath: string, filePath: string): string | null {
  const lexicalPath = resolveWithinHome(homePath, filePath);
  if (!lexicalPath || isDeniedFileApiPath(homePath, filePath)) {
    return null;
  }

  if (existsSync(lexicalPath)) {
    return resolveExistingFileApiPath(homePath, filePath);
  }

  if (!filePath.endsWith("/manifest.json")) {
    return lexicalPath;
  }

  const dirPath = dirname(lexicalPath);
  const fallbackCandidates = [join(dirPath, "module.json"), join(dirPath, "matrix.json")];
  for (const candidate of fallbackCandidates) {
    if (existsSync(candidate)) {
      const relativeCandidate = relative(homePath, candidate);
      return resolveExistingFileApiPath(homePath, relativeCandidate);
    }
  }

  return lexicalPath;
}

function toStatusCode(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode;
}
