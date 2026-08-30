import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { getActiveUserMachineByHandle, getContainer, type PlatformDB } from "./db.js";
import { buildCustomerVpsR2Key } from "./customer-vps-r2.js";
import { RuntimeSlotSchema } from "./customer-vps-schema.js";
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from "./platform-token.js";

const INTERNAL_SYNC_BODY_LIMIT = 64 * 1024;
const INTERNAL_SYNC_MULTIPART_COMPLETE_LIMIT = 1024 * 1024;
const INTERNAL_SYNC_OBJECT_BODY_LIMIT = 100 * 1024 * 1024;
const SYSTEM_STORAGE_PRESIGN_TTL_SECONDS = 300;
const SYSTEM_STORAGE_SINGLE_PUT_LIMIT = 64 * 1024 * 1024;
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SYSTEM_SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{4}Z\.dump$/;

interface R2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  headObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ exists: boolean; etag?: string }>;
  createMultipartUpload(key: string): Promise<string>;
  getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
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

interface MultipartCompleteInput extends MultipartCreateInput {
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

interface MultipartAbortInput extends MultipartCreateInput {
  uploadId: string;
}

async function getAuthorizedUserId(db: PlatformDB, handle: string): Promise<string | null> {
  const machine = await getActiveUserMachineByHandle(db, handle);
  if (machine?.clerkUserId) {
    return machine.clerkUserId;
  }
  const record = await getContainer(db, handle);
  if (record?.clerkUserId) {
    return record.clerkUserId;
  }
  return null;
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

const SystemStorageKeyInputSchema = z.object({
  key: z.string().min(1).max(512),
}).strict();

const SystemStoragePutInputSchema = SystemStorageKeyInputSchema.extend({
  size: z.number().int().nonnegative().max(SYSTEM_STORAGE_SINGLE_PUT_LIMIT),
}).strict();

function isValidRuntimeSlot(value: string): boolean {
  return RuntimeSlotSchema.safeParse(value).success;
}

function systemStorageAccess(key: string): "read" | "write" | null {
  if (key === "system/vps-meta.json") return "read";
  if (key === "system/db/latest") return "write";

  const primarySnapshot = /^system\/db\/snapshots\/([^/]+)$/.exec(key);
  if (primarySnapshot) {
    return SYSTEM_SNAPSHOT_NAME.test(primarySnapshot[1] ?? "") ? "write" : null;
  }

  const slotLatest = /^system\/runtime-slots\/([^/]+)\/db\/latest$/.exec(key);
  if (slotLatest) {
    return isValidRuntimeSlot(slotLatest[1] ?? "") ? "write" : null;
  }

  const slotSnapshot = /^system\/runtime-slots\/([^/]+)\/db\/snapshots\/([^/]+)$/.exec(key);
  if (slotSnapshot) {
    return isValidRuntimeSlot(slotSnapshot[1] ?? "") &&
      SYSTEM_SNAPSHOT_NAME.test(slotSnapshot[2] ?? "")
      ? "write"
      : null;
  }

  return null;
}

function systemStorageKey(
  c: { get: (key: "internalSyncUserId") => string },
  r2PrefixRoot: string,
  relativeKey: string,
): string {
  return buildCustomerVpsR2Key(r2PrefixRoot, c.get("internalSyncUserId"), relativeKey);
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
    partNumber > 10_000 ||
    uploadId.length > 512 ||
    expiresIn === null
  ) {
    return null;
  }
  return expiresIn === undefined
    ? { ...parsed, uploadId, partNumber }
    : { ...parsed, uploadId, partNumber, expiresIn };
}

function parseMultipartUploadIdInput(input: unknown): MultipartAbortInput | null {
  const parsed = parseMultipartCreateInput(input);
  const record = asRecord(input);
  if (!parsed || !record) return null;
  const uploadId = parseNonEmptyString(record.uploadId);
  return uploadId && uploadId.length <= 512 ? { ...parsed, uploadId } : null;
}

function parseMultipartCompleteInput(input: unknown): MultipartCompleteInput | null {
  const parsed = parseMultipartUploadIdInput(input);
  const record = asRecord(input);
  if (!parsed || !record || !Array.isArray(record.parts) || record.parts.length === 0 || record.parts.length > 10_000) {
    return null;
  }
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partNumbers = new Set<number>();
  for (const part of record.parts) {
    const partRecord = asRecord(part);
    if (!partRecord) return null;
    const partNumber = partRecord.partNumber;
    const etag = parseNonEmptyString(partRecord.etag);
    if (
      !etag ||
      etag.length > 512 ||
      !Number.isInteger(partNumber) ||
      typeof partNumber !== "number" ||
      partNumber <= 0 ||
      partNumber > 10_000
    ) {
      return null;
    }
    if (partNumbers.has(partNumber)) {
      return null;
    }
    partNumbers.add(partNumber);
    parts.push({ partNumber, etag });
  }
  return { ...parsed, parts };
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
  r2PrefixRoot: string;
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

    const userId = await getAuthorizedUserId(opts.db, handle);
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

  app.post("/system/exists", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = SystemStorageKeyInputSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success || systemStorageAccess(parsed.data.key) === null) {
      return c.json({ error: "Validation error" }, 400);
    }
    try {
      const result = await opts.r2.headObject(
        systemStorageKey(c, opts.r2PrefixRoot, parsed.data.key),
        { signal: AbortSignal.timeout(10_000) },
      );
      return c.json({ exists: result.exists });
    } catch (err: unknown) {
      console.error("[internal-sync] System object probe failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Storage probe failed" }, 502);
    }
  });

  app.post("/system/presign/get", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = SystemStorageKeyInputSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success || systemStorageAccess(parsed.data.key) === null) {
      return c.json({ error: "Validation error" }, 400);
    }
    const url = await opts.r2.getPresignedGetUrl(
      systemStorageKey(c, opts.r2PrefixRoot, parsed.data.key),
      SYSTEM_STORAGE_PRESIGN_TTL_SECONDS,
    );
    return c.json({ url });
  });

  app.post("/system/presign/put", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = SystemStoragePutInputSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "Validation error" }, 400);
    }
    if (systemStorageAccess(parsed.data.key) !== "write") {
      return c.json({ error: "Forbidden key" }, 403);
    }
    const url = await opts.r2.getPresignedPutUrl(
      systemStorageKey(c, opts.r2PrefixRoot, parsed.data.key),
      parsed.data.size,
      SYSTEM_STORAGE_PRESIGN_TTL_SECONDS,
    );
    return c.json({ url });
  });

  app.post("/system/multipart/create", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartCreateInput(await parseJsonBody(c));
    if (!parsed || systemStorageAccess(parsed.key) !== "write") {
      return c.json({ error: "Validation error" }, 400);
    }
    try {
      const uploadId = await opts.r2.createMultipartUpload(
        systemStorageKey(c, opts.r2PrefixRoot, parsed.key),
      );
      return c.json({ uploadId });
    } catch (err: unknown) {
      console.error("[internal-sync] System multipart creation failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Multipart creation failed" }, 502);
    }
  });

  app.post("/system/multipart/part", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartPartInput(await parseJsonBody(c));
    if (!parsed || systemStorageAccess(parsed.key) !== "write") {
      return c.json({ error: "Validation error" }, 400);
    }
    const url = await opts.r2.getPresignedPartUrl(
      systemStorageKey(c, opts.r2PrefixRoot, parsed.key),
      parsed.uploadId,
      parsed.partNumber,
      SYSTEM_STORAGE_PRESIGN_TTL_SECONDS,
    );
    return c.json({ url });
  });

  app.post(
    "/system/multipart/complete",
    bodyLimit({ maxSize: INTERNAL_SYNC_MULTIPART_COMPLETE_LIMIT }),
    async (c) => {
      const parsed = parseMultipartCompleteInput(await parseJsonBody(c));
      if (!parsed || systemStorageAccess(parsed.key) !== "write") {
        return c.json({ error: "Validation error" }, 400);
      }
      try {
        const result = await opts.r2.completeMultipartUpload(
          systemStorageKey(c, opts.r2PrefixRoot, parsed.key),
          parsed.uploadId,
          parsed.parts,
        );
        return c.json({ etag: result.etag ?? null });
      } catch (err: unknown) {
        console.error("[internal-sync] System multipart completion failed:", err instanceof Error ? err.message : String(err));
        return c.json({ error: "Multipart completion failed" }, 502);
      }
    },
  );

  app.post("/system/multipart/abort", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartUploadIdInput(await parseJsonBody(c));
    if (!parsed || systemStorageAccess(parsed.key) !== "write") {
      return c.json({ error: "Validation error" }, 400);
    }
    try {
      await opts.r2.abortMultipartUpload(
        systemStorageKey(c, opts.r2PrefixRoot, parsed.key),
        parsed.uploadId,
      );
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.error("[internal-sync] System multipart abort failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Multipart abort failed" }, 502);
    }
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

  app.post(
    "/multipart/complete",
    bodyLimit({ maxSize: INTERNAL_SYNC_MULTIPART_COMPLETE_LIMIT }),
    async (c) => {
      const parsed = parseMultipartCompleteInput(await parseJsonBody(c));
      if (!parsed) {
        return c.json({ error: "Validation error" }, 400);
      }
      const allowed = requireAllowedKey(c, parsed.key);
      if (allowed instanceof Response) return allowed;
      try {
        const result = await opts.r2.completeMultipartUpload(
          parsed.key,
          parsed.uploadId,
          parsed.parts,
        );
        return c.json({ etag: result.etag ?? null });
      } catch (err: unknown) {
        console.error(
          "[internal-sync] Multipart completion failed:",
          err instanceof Error ? err.message : String(err),
        );
        return c.json({ error: "Multipart completion failed" }, 500);
      }
    },
  );

  app.post("/multipart/abort", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartUploadIdInput(await parseJsonBody(c));
    if (!parsed) {
      return c.json({ error: "Validation error" }, 400);
    }
    const allowed = requireAllowedKey(c, parsed.key);
    if (allowed instanceof Response) return allowed;
    try {
      await opts.r2.abortMultipartUpload(parsed.key, parsed.uploadId);
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.error(
        "[internal-sync] Multipart abort failed:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Multipart abort failed" }, 500);
    }
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
