/** Durable owner admission and multipart receipts. Unverified jobs never appear in Chat. */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod/v4";
import { buildFileKey } from "../../sync/r2-keys.js";
import type { R2Client } from "../../sync/r2-client.js";
import type { ChatRepository } from "../repository.js";
import type { ChatOwner } from "../records.js";
import type { LocalChatImportJobsTable, LocalImportStatus } from "../import-database.js";
const PART_SIZE = 64 * 1024 * 1024;
const MAX_SIZE = 20 * 1024 * 1024 * 1024;
const MAX_JOBS = 8;
const LEASE_MS = 60_000;
const TTL_MS = 24 * 60 * 60_000;
const TERMINAL = ["failed", "cancelled", "expired"] as const;
const BeginSchema = z.object({ harness: z.enum(["codex", "claude"]), sourceId: z.uuid(),
  sourceAgentId: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), rawSize: z.number().int().min(1).max(MAX_SIZE),
  title: z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
const PartNumbersSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(320)).min(1).max(8)
  .refine((values) => new Set(values).size === values.length) }).strict();
const PartSchema = z.object({ partNumber: z.number().int().min(1).max(320),
  etag: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/), size: z.number().int().min(1).max(PART_SIZE) }).strict();
export class LocalChatImportJobError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "capacity" | "conflict" | "incomplete" | "expired" | "unavailable") {
    super("Chat import unavailable"); this.name = "LocalChatImportJobError";
  }
}
export interface LocalImportStorage extends Pick<R2Client, "createMultipartUpload" | "getPresignedPartUrl"
  | "completeMultipartUpload" | "abortMultipartUpload" | "deleteObject" | "headObject"> {
  /** Exact-key bounded recovery for a crash between storage allocation and its durable receipt. */
  listMultipartUploads(key: string): Promise<{ key: string; uploadId: string }[]>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new LocalChatImportJobError("invalid");
  return parsed.data;
}
function totalParts(job: { raw_size: number }) { return Math.ceil(Number(job.raw_size) / PART_SIZE); }
function partSize(job: { raw_size: number }, number: number) {
  if (number > totalParts(job)) throw new LocalChatImportJobError("invalid");
  return Math.min(PART_SIZE, Number(job.raw_size) - (number - 1) * PART_SIZE);
}
export class LocalChatImportJobs {
  constructor(private readonly options: { repository: ChatRepository; storage: LocalImportStorage;
    runtimeOwnerId: string; runtimeSlot?: string; now?: () => Date }) {}
  private get db() { return this.options.repository.kysely; }
  private now() { return this.options.now?.() ?? new Date(); }
  private owner(input: ChatOwner): string {
    if (input.type !== "personal" || input.ownerId !== this.options.runtimeOwnerId) throw new LocalChatImportJobError("not_found");
    return input.ownerId;
  }
  private key(ownerId: string, id: string): string {
    return buildFileKey({ ownerId, runtimeSlot: this.options.runtimeSlot ?? "primary" }, `.chat-imports/${id}/original.jsonl`);
  }
  private async row(owner: ChatOwner, idInput: string) {
    const ownerId = this.owner(owner); const id = parse(z.uuid(), idInput);
    const row = await this.db.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", id).where("owner_id", "=", ownerId).executeTakeFirst();
    if (!row) throw new LocalChatImportJobError("not_found"); return row;
  }
  private writable(row: { status: LocalImportStatus; expires_at: Date | string }) {
    if (row.status === "expired" || new Date(row.expires_at).getTime() <= this.now().getTime()) throw new LocalChatImportJobError("expired");
    if (row.status !== "uploading") throw new LocalChatImportJobError("conflict");
  }
  async get(owner: ChatOwner, id: string) {
    const row = await this.row(owner, id);
    const parts = await this.db.selectFrom("local_chat_import_parts").selectAll().where("job_id", "=", row.id).orderBy("part_number").limit(320).execute();
    return { jobId: row.id, status: row.status, partSize: PART_SIZE, totalParts: totalParts(row),
      expiresAt: new Date(row.expires_at).toISOString(), cleanupPending: row.cleanup_pending,
      parts: parts.map(p => ({ partNumber: p.part_number, etag: p.etag, size: Number(p.size_bytes) })),
      ...(row.chat_id ? { chatId: row.chat_id } : {}) };
  }
  async begin(owner: ChatOwner, value: unknown) {
    const ownerId = this.owner(owner); const request = parse(BeginSchema, value); const now = this.now();
    const allocation = await this.db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(54101, hashtext(${ownerId}))`.execute(trx);
      const existing = await trx.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", ownerId)
        .where("harness", "=", request.harness).where("source_id", "=", request.sourceId)
        .where("source_agent_id", "=", request.sourceAgentId ?? "").where("source_hash", "=", request.sourceHash)
        .where("status", "not in", TERMINAL).executeTakeFirst();
      if (existing) {
        if (Number(existing.raw_size) !== request.rawSize) throw new LocalChatImportJobError("conflict");
        return { row: existing, created: false };
      }
      const open = await trx.selectFrom("local_chat_import_jobs").select("id").where("owner_id", "=", ownerId)
        .where("status", "not in", [...TERMINAL, "published"]).limit(MAX_JOBS + 1).execute();
      if (open.length >= MAX_JOBS) throw new LocalChatImportJobError("capacity");
      const id = randomUUID();
      await trx.insertInto("local_chat_import_jobs").values({ id, owner_id: ownerId, harness: request.harness,
        source_id: request.sourceId, source_agent_id: request.sourceAgentId ?? "", source_hash: request.sourceHash,
        raw_size: request.rawSize, title: request.title, status: "creating", object_key: this.key(ownerId, id),
        upload_id: null, chat_id: null, lease_token: randomUUID(), lease_expires_at: new Date(now.getTime() + LEASE_MS),
        updated_at: now, cleanup_pending: false, error_code: null,
        expires_at: new Date(now.getTime() + TTL_MS) }).onConflict(oc => oc.doNothing()).execute();
      const row = await trx.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", ownerId)
        .where("harness", "=", request.harness).where("source_id", "=", request.sourceId)
        .where("source_agent_id", "=", request.sourceAgentId ?? "").where("source_hash", "=", request.sourceHash)
        .where("status", "not in", TERMINAL).executeTakeFirstOrThrow();
      return { row, created: row.id === id };
    });
    if (allocation.created) await this.allocate(allocation.row, false);
    return this.get(owner, allocation.row.id);
  }
  async presignParts(owner: ChatOwner, id: string, value: unknown) {
    const row = await this.row(owner, id); this.writable(row); const input = parse(PartNumbersSchema, value);
    if (!row.upload_id) throw new LocalChatImportJobError("unavailable");
    input.partNumbers.forEach(number => partSize(row, number));
    return Promise.all(input.partNumbers.map(async number => ({ partNumber: number, size: partSize(row, number),
      url: await this.options.storage.getPresignedPartUrl(row.object_key, row.upload_id!, number, 900),
      expiresAt: new Date(this.now().getTime() + 900_000).toISOString() })));
  }
  async acknowledgePart(owner: ChatOwner, id: string, value: unknown) {
    const ownerId = this.owner(owner); const jobId = parse(z.uuid(), id); const input = parse(PartSchema, value);
    await this.db.transaction().execute(async trx => {
      const row = await trx.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", ownerId).where("id", "=", jobId).forUpdate().executeTakeFirst();
      if (!row) throw new LocalChatImportJobError("not_found"); this.writable(row);
      if (input.size !== partSize(row, input.partNumber)) throw new LocalChatImportJobError("invalid");
      await trx.insertInto("local_chat_import_parts").values({ job_id: jobId, part_number: input.partNumber, etag: input.etag, size_bytes: input.size })
        .onConflict(oc => oc.columns(["job_id", "part_number"]).doUpdateSet({ etag: input.etag, size_bytes: input.size })).execute();
      await trx.updateTable("local_chat_import_jobs").set({ updated_at: this.now() }).where("id", "=", jobId).execute();
    });
    return this.get(owner, jobId);
  }
  async completeArchive(owner: ChatOwner, id: string) {
    const ownerId = this.owner(owner); const jobId = parse(z.uuid(), id);
    const sealing = await this.db.transaction().execute(async trx => {
      const row = await trx.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", jobId).where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!row) throw new LocalChatImportJobError("not_found");
      if (["uploaded", "verifying", "published"].includes(row.status)) return null;
      this.writable(row);
      const parts = await trx.selectFrom("local_chat_import_parts").selectAll().where("job_id", "=", jobId).orderBy("part_number").limit(320).execute();
      if (parts.length !== totalParts(row) || parts.some((part, index) => part.part_number !== index + 1 || Number(part.size_bytes) !== partSize(row, index + 1))) {
        throw new LocalChatImportJobError("incomplete");
      }
      if (!row.upload_id) throw new LocalChatImportJobError("unavailable");
      const leaseToken = randomUUID();
      const claimed = await trx.updateTable("local_chat_import_jobs").set({ status: "sealing", lease_token: leaseToken,
        lease_expires_at: new Date(this.now().getTime() + LEASE_MS), updated_at: this.now() }).where("id", "=", jobId).returningAll().executeTakeFirstOrThrow();
      return { row: claimed, parts: parts.map(p => ({ partNumber: p.part_number, etag: p.etag })) };
    });
    if (sealing) await this.seal(sealing.row, sealing.parts, false);
    return this.get(owner, jobId);
  }
  private async allocate(row: Awaited<ReturnType<LocalChatImportJobs["row"]>>, recover: boolean) {
    let uploadId: string | undefined;
    try {
      const existing = recover ? await this.options.storage.listMultipartUploads(row.object_key) : [];
      if (existing.length > 10 || existing.some(upload => upload.key !== row.object_key)) throw new LocalChatImportJobError("unavailable");
      if (existing.length === 1) uploadId = existing[0]!.uploadId;
      else {
        for (const upload of existing) await this.options.storage.abortMultipartUpload(row.object_key, upload.uploadId);
        uploadId = await this.options.storage.createMultipartUpload(row.object_key);
      }
      const updated = await this.db.updateTable("local_chat_import_jobs").set({ status: "uploading", upload_id: uploadId,
        lease_token: null, lease_expires_at: null, updated_at: this.now() }).where("id", "=", row.id)
        .where("owner_id", "=", row.owner_id).where("status", "=", "creating").where("lease_token", "=", row.lease_token).returning("id").executeTakeFirst();
      if (!updated) throw new LocalChatImportJobError("conflict");
    } catch (error: unknown) {
      console.warn("[chat/import] allocation failed", error instanceof Error ? error.name : "UnknownError");
      const failed = await this.db.updateTable("local_chat_import_jobs").set({ status: "failed", cleanup_pending: true, lease_token: null,
        lease_expires_at: null, updated_at: this.now() }).where("id", "=", row.id).where("owner_id", "=", row.owner_id)
        .where("status", "=", "creating").where("lease_token", "=", row.lease_token).returning("id").executeTakeFirst();
      if (failed && uploadId) await this.options.storage.abortMultipartUpload(row.object_key, uploadId).catch((cleanup: unknown) => {
        console.warn("[chat/import] allocation cleanup pending", cleanup instanceof Error ? cleanup.name : "UnknownError");
      });
      throw error instanceof LocalChatImportJobError ? error : new LocalChatImportJobError("unavailable");
    }
  }
  private async seal(row: Awaited<ReturnType<LocalChatImportJobs["row"]>>, parts: { partNumber: number; etag: string }[], recover: boolean) {
    try {
      if (!row.upload_id) throw new LocalChatImportJobError("unavailable");
      const exists = recover && (await this.options.storage.headObject(row.object_key)).exists;
      if (!exists) await this.options.storage.completeMultipartUpload(row.object_key, row.upload_id, parts);
      await this.db.updateTable("local_chat_import_jobs").set({ status: "uploaded", lease_token: null, lease_expires_at: null, updated_at: this.now() })
        .where("id", "=", row.id).where("owner_id", "=", row.owner_id).where("status", "=", "sealing").where("lease_token", "=", row.lease_token).execute();
    } catch (error: unknown) {
      if (error instanceof Error && ["InvalidPart", "InvalidPartOrder", "MultipartReceiptMismatchError"].includes(error.name)) {
        await this.db.transaction().execute(async trx => {
          const restored = await trx.updateTable("local_chat_import_jobs").set({ status: "uploading", lease_token: null,
            lease_expires_at: null, updated_at: this.now() }).where("id", "=", row.id).where("owner_id", "=", row.owner_id)
            .where("status", "=", "sealing").where("lease_token", "=", row.lease_token).returning("id").executeTakeFirst();
          if (restored) await trx.deleteFrom("local_chat_import_parts").where("job_id", "=", row.id).execute();
        });
        throw new LocalChatImportJobError("incomplete");
      }
      console.warn("[chat/import] archive completion pending", error instanceof Error ? error.name : "UnknownError");
      throw new LocalChatImportJobError("unavailable");
    }
  }
  async recoverPending(): Promise<void> {
    const now = this.now();
    const claimed = await this.db.transaction().execute(async trx => {
      const rows = await trx.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", this.options.runtimeOwnerId)
        .where("status", "in", ["creating", "sealing"]).where("lease_expires_at", "<=", now).where("expires_at", ">", now)
        .orderBy("updated_at").limit(1).forUpdate().skipLocked().execute();
      const claims = [];
      for (const row of rows) {
        const claim = await trx.updateTable("local_chat_import_jobs").set({ lease_token: randomUUID(),
          lease_expires_at: new Date(now.getTime() + 10 * 60_000), updated_at: now }).where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
        claims.push(claim);
      }
      return claims;
    });
    for (const row of claimed) {
      try {
        if (row.status === "creating") await this.allocate(row, true);
        else {
          const parts = await this.db.selectFrom("local_chat_import_parts").selectAll().where("job_id", "=", row.id).orderBy("part_number").limit(320).execute();
          if (parts.length !== totalParts(row)) throw new LocalChatImportJobError("incomplete");
          await this.seal(row, parts.map(p => ({ partNumber: p.part_number, etag: p.etag })), true);
        }
      } catch (error: unknown) {
        console.warn("[chat/import] recovery pending", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }
  async cancel(owner: ChatOwner, id: string) {
    const ownerId = this.owner(owner); const jobId = parse(z.uuid(), id);
    const row = await this.db.transaction().execute(async trx => {
      const current = await trx.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", ownerId).where("id", "=", jobId).forUpdate().executeTakeFirst();
      if (!current) throw new LocalChatImportJobError("not_found");
      if (["creating", "sealing", "verifying", "published"].includes(current.status)) throw new LocalChatImportJobError("conflict");
      return trx.updateTable("local_chat_import_jobs").set({ status: "cancelled", cleanup_pending: true, updated_at: this.now() })
        .where("id", "=", jobId).returningAll().executeTakeFirstOrThrow();
    });
    await this.cleanup(row); return this.get(owner, jobId);
  }
  async expire(now = this.now()): Promise<void> {
    await this.db.transaction().execute(async trx => {
      const stale = await trx.selectFrom("local_chat_import_jobs").select("id").where("owner_id", "=", this.options.runtimeOwnerId)
        .where("status", "not in", [...TERMINAL, "published"]).where("expires_at", "<=", now)
        .where(eb => eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)]))
        .orderBy("expires_at").limit(50).forUpdate().skipLocked().execute();
      for (const row of stale) await trx.updateTable("local_chat_import_jobs").set({ status: "expired", cleanup_pending: true, updated_at: now }).where("id", "=", row.id).execute();
    });
    const garbage = await this.db.selectFrom("local_chat_import_jobs").selectAll().where("owner_id", "=", this.options.runtimeOwnerId)
      .where("cleanup_pending", "=", true).where("status", "in", TERMINAL).orderBy("updated_at").limit(50).execute();
    for (const row of garbage) await this.cleanup(row);
  }
  private async cleanup(row: Pick<LocalChatImportJobsTable, "id" | "owner_id" | "object_key" | "upload_id">): Promise<void> {
    if (row.object_key !== this.key(row.owner_id, row.id)) throw new LocalChatImportJobError("unavailable");
    try {
      const incomplete = await this.options.storage.listMultipartUploads(row.object_key);
      if (incomplete.length > 10 || incomplete.some(upload => upload.key !== row.object_key)) throw new LocalChatImportJobError("unavailable");
      const uploads = new Set(incomplete.map(upload => upload.uploadId));
      if (row.upload_id) uploads.add(row.upload_id);
      for (const uploadId of uploads) await this.options.storage.abortMultipartUpload(row.object_key, uploadId);
      await this.options.storage.deleteObject(row.object_key);
      await this.db.updateTable("local_chat_import_jobs").set({ cleanup_pending: false, updated_at: this.now() })
        .where("id", "=", row.id).where("owner_id", "=", row.owner_id).where("status", "in", TERMINAL).execute();
    } catch (error: unknown) {
      console.warn("[chat/import] expired archive cleanup pending", error instanceof Error ? error.name : "UnknownError");
    }
  }
}
