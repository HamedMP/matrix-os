import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, posix } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { getMimeType } from "./file-utils.js";
import {
  resolveExistingFileApiPath,
  resolveWritableFileApiPath,
} from "./path-security.js";

const FILE_BLOB_BODY_LIMIT = 10 * 1024 * 1024;

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const requestedEnd = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

const BoolQuerySchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const BlobQuerySchema = z.object({
  path: z.string().trim().min(1).max(4096),
  filename: z.string()
    .min(1)
    .max(255)
    .regex(/^[^/\0]+$/)
    .refine((value) => value !== "." && value !== "..")
    .optional(),
  force: BoolQuerySchema,
  secret: BoolQuerySchema,
});

export interface FileBlobRouteDeps {
  homePath: string;
}

function invalidPath(c: Context) {
  return c.json({ error: "invalid_path" }, 400);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

export function createFileBlobRoutes(deps: FileBlobRouteDeps): Hono {
  const app = new Hono();
  const putBodyLimit = bodyLimit({
    maxSize: FILE_BLOB_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });

  function parseQuery(c: Context) {
    const parsed = BlobQuerySchema.safeParse({
      path: c.req.query("path"),
      filename: c.req.query("filename"),
      force: c.req.query("force"),
      secret: c.req.query("secret"),
    });
    return parsed.success ? parsed.data : null;
  }

  app.get("/blob", async (c) => {
    const parsed = parseQuery(c);
    if (!parsed) return invalidPath(c);

    const resolved = resolveExistingFileApiPath(deps.homePath, parsed.path);
    if (!resolved) return c.json({ error: "not_found" }, 404);

    const stats = await stat(resolved);
    if (!stats.isFile()) return c.json({ error: "not_file" }, 400);
    if (stats.size > FILE_BLOB_BODY_LIMIT) return c.json({ error: "payload_too_large" }, 413);

    const body = await readFile(resolved);
    return c.body(body, 200, {
      "Content-Type": getMimeType(extname(basename(resolved))),
      "Content-Length": String(stats.size),
    });
  });

  app.get("/media", async (c) => {
    const parsed = parseQuery(c);
    if (!parsed) return invalidPath(c);

    const resolved = resolveExistingFileApiPath(deps.homePath, parsed.path);
    if (!resolved) return c.json({ error: "not_found" }, 404);

    const stats = await stat(resolved);
    if (!stats.isFile()) return c.json({ error: "not_file" }, 400);

    const rangeHeader = c.req.header("range");
    const range = rangeHeader ? parseByteRange(rangeHeader, stats.size) : null;
    if (rangeHeader && !range) {
      return c.body(null, 416, {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${stats.size}`,
        "Cache-Control": "private, no-store",
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stats.size - 1);
    const contentLength = stats.size === 0 ? 0 : end - start + 1;
    const nodeStream = createReadStream(resolved, range ? { start, end } : undefined);
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Length": String(contentLength),
      "Content-Type": getMimeType(extname(basename(resolved))),
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  });

  app.put("/blob", putBodyLimit, async (c) => {
    const parsed = parseQuery(c);
    if (!parsed) return invalidPath(c);

    let destinationPath = parsed.path;
    let resolved = resolveWritableFileApiPath(deps.homePath, destinationPath);
    if (!resolved) return invalidPath(c);

    try {
      const existing = await lstat(resolved);
      if (existing.isDirectory()) {
        if (!parsed.filename) return c.json({ error: "not_file" }, 400);
        destinationPath = posix.join(destinationPath, parsed.filename);
        resolved = resolveWritableFileApiPath(deps.homePath, destinationPath);
        if (!resolved) return invalidPath(c);
      }
    } catch (err: unknown) {
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
      if (parsed.path.endsWith("/") && parsed.filename) {
        destinationPath = posix.join(parsed.path, parsed.filename);
        resolved = resolveWritableFileApiPath(deps.homePath, destinationPath);
        if (!resolved) return invalidPath(c);
      }
    }

    if (!resolved) return invalidPath(c);
    const uploadPath = resolved;
    try {
      const existing = await lstat(uploadPath);
      if (existing.isDirectory()) return c.json({ error: "not_file" }, 400);
      if (!parsed.force) return c.json({ error: "file_exists" }, 409);
    } catch (err: unknown) {
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
    }

    const body = Buffer.from(await c.req.arrayBuffer());
    const parent = dirname(uploadPath);
    const tmpPath = `${uploadPath}.matrix-upload-${randomUUID()}.tmp`;
    const mode = parsed.secret ? 0o600 : 0o644;

    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await writeFile(tmpPath, body, { flag: "wx", mode });
      await rename(tmpPath, uploadPath);
      return c.json({ ok: true, path: destinationPath, size: body.byteLength });
    } catch (err: unknown) {
      await safeUnlink(tmpPath);
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return invalidPath(c);
      }
      console.error("[file-blob] upload failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "write_failed" }, 500);
    }
  });

  return app;
}
