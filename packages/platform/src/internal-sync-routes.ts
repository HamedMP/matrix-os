import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getContainer, type PlatformDB } from "./db.js";
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from "./platform-token.js";

const INTERNAL_SYNC_BODY_LIMIT = 64 * 1024;
const INTERNAL_SYNC_OBJECT_BODY_LIMIT = 100 * 1024 * 1024;
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;

interface R2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  getObject(key: string): Promise<{ body: ReadableStream | null; etag?: string }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<{ etag?: string }>;
  deleteObject(key: string): Promise<void>;
}

interface PresignGetInput {
  key: string;
  expiresIn?: number;
}

interface PresignPutInput extends PresignGetInput {
  size: number;
}

interface MultipartCreateInput {
  key: string;
}

interface MultipartPartInput extends MultipartCreateInput {
  uploadId: string;
  partNumber: number;
  expiresIn?: number;
}

function getAuthorizedUserId(db: PlatformDB, handle: string): string | null {
  const record = getContainer(db, handle);
  return record?.clerkUserId ?? null;
}

function buildManifestKey(userId: string): string {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid sync user id");
  }
  return `matrixos-sync/${userId}/manifest.json`;
}

function keyAllowedForUser(key: string, userId: string): boolean {
  return key === buildManifestKey(userId) || key.startsWith(`matrixos-sync/${userId}/files/`);
}

function isNoSuchKeyError(err: unknown): boolean {
  return err instanceof Error && (err.name === "NoSuchKey" || err.message.includes("NoSuchKey"));
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : null;
}

function parseExpiresIn(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && typeof value === "number" && value > 0 && value <= 86_400
    ? value
    : null;
}

function parseNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePresignGetInput(input: unknown): PresignGetInput | null {
  const record = asRecord(input);
  if (!record) return null;
  const key = parseNonEmptyString(record.key);
  const expiresIn = parseExpiresIn(record.expiresIn);
  if (!key || expiresIn === null) return null;
  return expiresIn === undefined ? { key } : { key, expiresIn };
}

function parsePresignPutInput(input: unknown): PresignPutInput | null {
  const parsed = parsePresignGetInput(input);
  const record = asRecord(input);
  if (!parsed || !record) return null;
  const size = record.size;
  if (!Number.isInteger(size) || typeof size !== "number" || size < 0 || size > 1024 * 1024 * 1024) {
    return null;
  }
  return { ...parsed, size };
}

function parseMultipartCreateInput(input: unknown): MultipartCreateInput | null {
  const record = asRecord(input);
  if (!record) return null;
  const key = parseNonEmptyString(record.key);
  return key ? { key } : null;
}

function parseMultipartPartInput(input: unknown): MultipartPartInput | null {
  const parsed = parseMultipartCreateInput(input);
  const record = asRecord(input);
  if (!parsed || !record) return null;
  const uploadId = parseNonEmptyString(record.uploadId);
  const partNumber = record.partNumber;
  const expiresIn = parseExpiresIn(record.expiresIn);
  if (
    !uploadId ||
    !Number.isInteger(partNumber) ||
    typeof partNumber !== "number" ||
    partNumber <= 0 ||
    expiresIn === null
  ) {
    return null;
  }
  return expiresIn === undefined
    ? { ...parsed, uploadId, partNumber }
    : { ...parsed, uploadId, partNumber, expiresIn };
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      console.warn(
        "[internal-sync] JSON parse failed:",
        err.message,
      );
      return null;
    }
    throw err;
  }
}

export function createInternalSyncRoutes(opts: {
  db: PlatformDB;
  r2: R2Client;
  platformSecret: string;
}): Hono<any> {
  const app = new Hono<{ Variables: { internalSyncUserId: string } }>();

  app.use("*", async (c, next) => {
    const handle = c.req.param("handle");
    if (!handle) {
      return c.json({ error: "Missing handle" }, 400);
    }
    if (!opts.platformSecret) {
      return c.json({ error: "Internal sync not configured" }, 503);
    }
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const expected = buildPlatformVerificationToken(handle, opts.platformSecret);
    if (!timingSafeTokenEquals(token, expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const userId = getAuthorizedUserId(opts.db, handle);
    if (!userId) {
      return c.json({ error: "Unknown handle" }, 404);
    }

    c.set("internalSyncUserId", userId);
    return next();
  });

  function requireAllowedKey(
    c: { get: (key: "internalSyncUserId") => string; json: (body: unknown, status?: number) => Response },
    key: string,
  ): string | Response {
    const userId = c.get("internalSyncUserId");
    if (!keyAllowedForUser(key, userId)) {
      return c.json({ error: "Forbidden key" }, 403);
    }
    return userId;
  }

  app.post("/presign/get", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parsePresignGetInput(await parseJsonBody(c));
    if (!parsed) {
      return c.json({ error: "Validation error" }, 400);
    }
    const allowed = requireAllowedKey(c, parsed.key);
    if (allowed instanceof Response) return allowed;
    const url = await opts.r2.getPresignedGetUrl(parsed.key, parsed.expiresIn);
    return c.json({ url });
  });

  app.post("/presign/put", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parsePresignPutInput(await parseJsonBody(c));
    if (!parsed) {
      return c.json({ error: "Validation error" }, 400);
    }
    const allowed = requireAllowedKey(c, parsed.key);
    if (allowed instanceof Response) return allowed;
    const url = await opts.r2.getPresignedPutUrl(
      parsed.key,
      parsed.size,
      parsed.expiresIn,
    );
    return c.json({ url });
  });

  app.post("/multipart/create", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartCreateInput(await parseJsonBody(c));
    if (!parsed) {
      return c.json({ error: "Validation error" }, 400);
    }
    const allowed = requireAllowedKey(c, parsed.key);
    if (allowed instanceof Response) return allowed;
    const uploadId = await opts.r2.createMultipartUpload(parsed.key);
    return c.json({ uploadId });
  });

  app.post("/multipart/part", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartPartInput(await parseJsonBody(c));
    if (!parsed) {
      return c.json({ error: "Validation error" }, 400);
    }
    const allowed = requireAllowedKey(c, parsed.key);
    if (allowed instanceof Response) return allowed;
    const url = await opts.r2.getPresignedPartUrl(
      parsed.key,
      parsed.uploadId,
      parsed.partNumber,
      parsed.expiresIn,
    );
    return c.json({ url });
  });

  app.get("/object", async (c) => {
    const key = c.req.query("key");
    if (!key) {
      return c.json({ error: "Missing key" }, 400);
    }
    const allowed = requireAllowedKey(c, key);
    if (allowed instanceof Response) return allowed;
    try {
      const result = await opts.r2.getObject(key);
      if (!result.body) {
        return c.body(null, 404);
      }
      if (result.etag) {
        c.header("ETag", result.etag);
      }
      return new Response(result.body as BodyInit, {
        status: 200,
        headers: result.etag ? { ETag: result.etag } : undefined,
      });
    } catch (err) {
      if (isNoSuchKeyError(err)) {
        return c.json({ error: "Not found" }, 404);
      }
      throw err;
    }
  });

  app.put("/object", bodyLimit({ maxSize: INTERNAL_SYNC_OBJECT_BODY_LIMIT }), async (c) => {
    const key = c.req.query("key");
    if (!key) {
      return c.json({ error: "Missing key" }, 400);
    }
    const allowed = requireAllowedKey(c, key);
    if (allowed instanceof Response) return allowed;
    const body = c.req.raw.body ?? new Uint8Array();
    const result = await opts.r2.putObject(key, body);
    return c.json({ etag: result.etag ?? null });
  });

  app.delete("/object", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const key = c.req.query("key");
    if (!key) {
      return c.json({ error: "Missing key" }, 400);
    }
    const allowed = requireAllowedKey(c, key);
    if (allowed instanceof Response) return allowed;
    await opts.r2.deleteObject(key);
    return c.json({ ok: true });
  });

  return app;
}
