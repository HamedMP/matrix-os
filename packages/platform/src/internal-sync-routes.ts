import { createStorageDeletionAdmissionMiddleware } from './account-deletion/storage-admission.js';
import { Hono } from "hono";
import { Readable } from "node:stream";
import {
  buildSyncStoragePrefix,
  SyncRuntimeSlotSchema,
  type SyncScope,
} from "@matrix-os/contracts";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { getActiveUserMachineByHandle, getContainer, type PlatformDB } from "./db.js";
import {
  createStorageQuota,
  DEFAULT_STORAGE_QUOTA_LIMITS,
  type StorageQuotaDecision,
  type StorageQuotaLimits,
} from "./free-tier/storage-quota.js";
import { buildCustomerVpsR2Key } from "./customer-vps-r2.js";
import { RuntimeSlotSchema } from "./customer-vps-schema.js";
import {
  buildPlatformVerificationToken,
  buildPlatformSyncVerificationToken,
  timingSafeTokenEquals,
} from "./platform-token.js";

const INTERNAL_SYNC_BODY_LIMIT = 64 * 1024;
const INTERNAL_SYNC_MULTIPART_COMPLETE_LIMIT = 1024 * 1024;
const INTERNAL_SYNC_OBJECT_BODY_LIMIT = 100 * 1024 * 1024;
const SYSTEM_STORAGE_PRESIGN_TTL_SECONDS = 300;
const SYSTEM_STORAGE_SINGLE_PUT_LIMIT = 64 * 1024 * 1024;
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const SYSTEM_SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{4}Z\.dump$/;
const DEFAULT_PRESIGN_TTL_SECONDS = 900;
/** A proxied body has this long to stream before its reservation is reconciled against the store. */
const PROXY_PUT_PENDING_MS = 15 * 60_000;
const PRESIGN_PENDING_MARGIN_MS = 60_000;

interface R2Client {
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  headObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ exists: boolean; etag?: string; contentLength?: number }>;
  listMultipartUploads(key: string): Promise<{ key: string; uploadId: string }[]>;
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
  getObject(key: string, options?: { signal?: AbortSignal }): Promise<{ body: unknown; etag?: string; contentLength?: number }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { contentLength?: number },
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

async function getAuthorizedOwner(db: PlatformDB, handle: string): Promise<{ userId: string; metered: boolean } | null> {
  const machine = await getActiveUserMachineByHandle(db, handle, "primary");
  if (machine?.clerkUserId) {
    return { userId: machine.clerkUserId, metered: machine.substrate === "container" };
  }
  const record = await getContainer(db, handle);
  if (record?.clerkUserId) {
    return { userId: record.clerkUserId, metered: false };
  }
  return null;
}

function buildManifestKey(scope: SyncScope): string {
  if (!SAFE_USER_ID.test(scope.ownerId)) {
    throw new Error("Invalid sync user id");
  }
  return `${buildSyncStoragePrefix(scope)}/manifest.json`;
}

function keyAllowedForScope(key: string, scope: SyncScope): boolean {
  const prefix = buildSyncStoragePrefix(scope);
  return key === buildManifestKey(scope)
    || key.startsWith(`${prefix}/files/`)
    || key.startsWith(`${prefix}/manifests/`)
    || key.startsWith(`${prefix}/staging/`)
    || key.startsWith(`${prefix}/objects/sha256/`);
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

function systemStorageAccess(
  key: string,
  runtimeSlot: string,
): "read" | "write" | null {
  if (key === "system/vps-meta.json") return runtimeSlot === "primary" ? "read" : null;
  if (key === "system/db/latest") return runtimeSlot === "primary" ? "write" : null;

  const primarySnapshot = /^system\/db\/snapshots\/([^/]+)$/.exec(key);
  if (primarySnapshot) {
    return runtimeSlot === "primary" && SYSTEM_SNAPSHOT_NAME.test(primarySnapshot[1] ?? "")
      ? "write"
      : null;
  }

  const slotLatest = /^system\/runtime-slots\/([^/]+)\/db\/latest$/.exec(key);
  if (slotLatest) {
    return slotLatest[1] === runtimeSlot && runtimeSlot !== "primary" ? "write" : null;
  }

  const slotSnapshot = /^system\/runtime-slots\/([^/]+)\/db\/snapshots\/([^/]+)$/.exec(key);
  if (slotSnapshot) {
    return runtimeSlot !== "primary" && slotSnapshot[1] === runtimeSlot &&
      isValidRuntimeSlot(slotSnapshot[1] ?? "") &&
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
  /** Container runtimes are metered against these; VPS owners are not. */
  storageLimits?: StorageQuotaLimits;
  now?: () => Date;
}): Hono<any> {
  const app = new Hono<{ Variables: {
    internalSyncUserId: string;
    internalSyncScope: SyncScope;
    internalSyncMetered: boolean;
  } }>();
  const quota = createStorageQuota({
    db: opts.db,
    limits: opts.storageLimits ?? DEFAULT_STORAGE_QUOTA_LIMITS,
    headObject: (key, options) => opts.r2.headObject(key, options),
    ...(opts.now ? { now: opts.now } : {}),
  });

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
    const machineId = c.req.header("x-matrix-machine-id")?.trim();
    const runtimeHeader = c.req.header("x-matrix-runtime-slot")?.trim();
    let scope: SyncScope;
    let metered = false;
    if (machineId || runtimeHeader) {
      const runtime = SyncRuntimeSlotSchema.safeParse(runtimeHeader);
      if (!machineId || machineId.length > 128 || !runtime.success) {
        return c.json({ error: "Invalid runtime identity" }, 400);
      }
      const machine = await getActiveUserMachineByHandle(opts.db, handle, runtime.data);
      if (!machine || machine.machineId !== machineId) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const expected = buildPlatformSyncVerificationToken({
        handle,
        machineId: machine.machineId,
        runtimeSlot: machine.runtimeSlot,
      }, opts.platformSecret, machine.runtimeTokenEpoch);
      if (!timingSafeTokenEquals(token, expected)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      scope = { ownerId: machine.clerkUserId, runtimeSlot: machine.runtimeSlot };
      metered = machine.substrate === "container";
    } else {
      const expected = buildPlatformVerificationToken(handle, opts.platformSecret);
      if (!timingSafeTokenEquals(token, expected)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const owner = await getAuthorizedOwner(opts.db, handle);
      if (!owner) {
        return c.json({ error: "Unknown handle" }, 404);
      }
      // A container holds the handle token for owner proofs, and it survives a
      // generation change; only the epoch-bound runtime identity reaches its storage.
      if (owner.metered) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      scope = { ownerId: owner.userId, runtimeSlot: "primary" };
      metered = owner.metered;
    }

    c.set("internalSyncUserId", scope.ownerId);
    c.set("internalSyncScope", scope);
    c.set("internalSyncMetered", metered);
    return next();
  });

  app.use("*", createStorageDeletionAdmissionMiddleware(opts.db));

  function requireAllowedKey(
    c: { get: (key: "internalSyncScope") => SyncScope; json: (body: unknown, status?: number) => Response },
    key: string,
  ): string | Response {
    const scope = c.get("internalSyncScope");
    if (!keyAllowedForScope(key, scope)) {
      return c.json({ error: "Forbidden key" }, 403);
    }
    return scope.ownerId;
  }

  type QuotaContext = {
    get(key: "internalSyncScope"): SyncScope;
    get(key: "internalSyncMetered"): boolean;
  };

  function countsAsFile(key: string, scope: SyncScope): boolean {
    const prefix = buildSyncStoragePrefix(scope);
    return key.startsWith(`${prefix}/objects/sha256/`) || key.startsWith(`${prefix}/files/`);
  }

  /** Null when the owner is not metered. */
  async function meter(
    c: QuotaContext,
    key: string,
    bytes: number,
    pendingMs: number | null,
  ): Promise<StorageQuotaDecision | null> {
    if (!c.get("internalSyncMetered")) return null;
    const scope = c.get("internalSyncScope");
    return quota.authorize(scope.ownerId, { key, bytes, countsAsFile: countsAsFile(key, scope), pendingMs });
  }

  function refusal(c: { json: (body: unknown, status?: number) => Response }, decision: StorageQuotaDecision): Response | null {
    if (decision.ok) return null;
    return decision.code === "storage_full"
      ? c.json({ error: "Storage limit reached", code: "storage_full" }, 507)
      : c.json({ error: "File limit reached", code: "file_limit_reached" }, 507);
  }

  /** Multipart sizes are known only once the object exists; one that does not fit is removed unless it replaced a counted key. */
  async function meterCompleted(
    c: QuotaContext & { json: (body: unknown, status?: number) => Response },
    key: string,
  ): Promise<Response | null> {
    if (!c.get("internalSyncMetered")) return null;
    const head = await opts.r2.headObject(key, { signal: AbortSignal.timeout(10_000) });
    if (!head.exists || head.contentLength === undefined || !Number.isSafeInteger(head.contentLength)) {
      throw new Error("Completed object size unavailable");
    }
    const decision = await meter(c, key, head.contentLength, null);
    if (!decision || decision.ok) return null;
    if (!decision.priorExisted) await opts.r2.deleteObject(key);
    return refusal(c, decision);
  }

  function presignPendingMs(expiresIn: number | undefined): number {
    return (expiresIn ?? DEFAULT_PRESIGN_TTL_SECONDS) * 1000 + PRESIGN_PENDING_MARGIN_MS;
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
    const decision = await meter(c, parsed.key, parsed.size, presignPendingMs(parsed.expiresIn));
    const refused = decision && refusal(c, decision);
    if (refused) return refused;
    const url = await opts.r2.getPresignedPutUrl(
      parsed.key,
      parsed.size,
      parsed.expiresIn,
    );
    return c.json({ url });
  });

  app.post("/system/exists", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = SystemStorageKeyInputSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success || systemStorageAccess(
      parsed.data.key,
      c.get("internalSyncScope").runtimeSlot,
    ) === null) {
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
    if (!parsed.success || systemStorageAccess(
      parsed.data.key,
      c.get("internalSyncScope").runtimeSlot,
    ) === null) {
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
    if (systemStorageAccess(
      parsed.data.key,
      c.get("internalSyncScope").runtimeSlot,
    ) !== "write") {
      return c.json({ error: "Forbidden key" }, 403);
    }
    const key = systemStorageKey(c, opts.r2PrefixRoot, parsed.data.key);
    const decision = await meter(c, key, parsed.data.size, presignPendingMs(SYSTEM_STORAGE_PRESIGN_TTL_SECONDS));
    const refused = decision && refusal(c, decision);
    if (refused) return refused;
    const url = await opts.r2.getPresignedPutUrl(key, parsed.data.size, SYSTEM_STORAGE_PRESIGN_TTL_SECONDS);
    return c.json({ url });
  });

  app.post("/system/multipart/create", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartCreateInput(await parseJsonBody(c));
    if (!parsed || systemStorageAccess(parsed.key, c.get("internalSyncScope").runtimeSlot) !== "write") {
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
    if (!parsed || systemStorageAccess(parsed.key, c.get("internalSyncScope").runtimeSlot) !== "write") {
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
      if (!parsed || systemStorageAccess(parsed.key, c.get("internalSyncScope").runtimeSlot) !== "write") {
        return c.json({ error: "Validation error" }, 400);
      }
      try {
        const key = systemStorageKey(c, opts.r2PrefixRoot, parsed.key);
        const result = await opts.r2.completeMultipartUpload(key, parsed.uploadId, parsed.parts);
        const refused = await meterCompleted(c, key);
        if (refused) return refused;
        return c.json({ etag: result.etag ?? null });
      } catch (err: unknown) {
        console.error("[internal-sync] System multipart completion failed:", err instanceof Error ? err.message : String(err));
        return c.json({ error: "Multipart completion failed" }, 502);
      }
    },
  );

  app.post("/system/multipart/abort", bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
    const parsed = parseMultipartUploadIdInput(await parseJsonBody(c));
    if (!parsed || systemStorageAccess(parsed.key, c.get("internalSyncScope").runtimeSlot) !== "write") {
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

  for (const path of ["/multipart/list", "/object/head"] as const) {
    app.post(path, bodyLimit({ maxSize: INTERNAL_SYNC_BODY_LIMIT }), async (c) => {
      const parsed = SystemStorageKeyInputSchema.safeParse(await parseJsonBody(c));
      if (!parsed.success) return c.json({ error: "Validation error" }, 400);
      const allowed = requireAllowedKey(c, parsed.data.key);
      if (allowed instanceof Response) return allowed;
      try {
        if (path === "/object/head") {
          const result = await opts.r2.headObject(parsed.data.key);
          return c.json({ exists: result.exists });
        }
        const uploads = await opts.r2.listMultipartUploads(parsed.data.key);
        if (uploads.length > 10 || uploads.some(upload => upload.key !== parsed.data.key || !upload.uploadId || upload.uploadId.length > 1024)) {
          throw new Error("Unsafe recovery result");
        }
        return c.json({ uploads });
      } catch (error: unknown) {
        console.error("[internal-sync] Storage recovery failed", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "Storage recovery unavailable" }, 500);
      }
    });
  }

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
        const refused = await meterCompleted(c, parsed.key);
        if (refused) return refused;
        return c.json({ etag: result.etag ?? null });
      } catch (err: unknown) {
        if (err instanceof Error && ["InvalidPart", "InvalidPartOrder"].includes(err.name)) {
          return c.json({ error: "Multipart completion unavailable", code: "receipt_mismatch" }, 409);
        }
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
      const result = await opts.r2.getObject(key, { signal: AbortSignal.timeout(120_000) });
      if (!result.body) {
        return c.body(null, 404);
      }
      const stream = result.body instanceof Readable ? Readable.toWeb(result.body) : result.body;
      if (!stream || typeof (stream as ReadableStream).getReader !== "function") {
        throw new Error("Invalid storage stream");
      }
      if (result.etag) {
        c.header("ETag", result.etag);
      }
      if (result.contentLength !== undefined && Number.isSafeInteger(result.contentLength) && result.contentLength >= 0) {
        c.header("Content-Length", String(result.contentLength));
      }
      return new Response(stream as BodyInit, {
        status: 200,
        headers: {
          ...(result.etag ? { ETag: result.etag } : {}),
          ...(result.contentLength !== undefined && Number.isSafeInteger(result.contentLength) && result.contentLength >= 0
            ? { "Content-Length": String(result.contentLength) } : {}),
        },
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
    // Storage needs the exact length to stream; chunked bodies are buffered within the body limit.
    const declared = c.req.header("content-length");
    const contentLength = declared && /^\d{1,12}$/.test(declared) ? Number(declared) : undefined;
    const streamed = contentLength !== undefined && c.req.raw.body !== null
      && contentLength <= INTERNAL_SYNC_OBJECT_BODY_LIMIT;
    const buffered = streamed ? null : new Uint8Array(await c.req.arrayBuffer());
    const decision = await meter(c, key, streamed ? contentLength! : buffered!.byteLength, PROXY_PUT_PENDING_MS);
    const refused = decision && refusal(c, decision);
    if (refused) return refused;
    const result = streamed
      ? await opts.r2.putObject(key, c.req.raw.body!, { contentLength })
      : await opts.r2.putObject(key, buffered!);
    if (decision?.ok) await quota.confirm(c.get("internalSyncScope").ownerId, key, decision.reservationId);
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
    if (c.get("internalSyncMetered")) await quota.release(c.get("internalSyncScope").ownerId, key);
    return c.json({ ok: true });
  });

  return app;
}
