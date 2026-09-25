import { createHash, randomUUID } from "node:crypto";
import { OrganizationDriveFileSchema, OrganizationDriveUploadRequestSchema, type OrganizationDriveFile, type OrganizationDriveUploadRequest } from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import { buildFileKey } from "../sync/r2-keys.js";
import { resolveSyncScope } from "../sync/runtime-scope.js";
import type { OrganizationDriveDatabase, OrganizationDriveUploadsTable } from "./database.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_TTL_MS = 30 * 60_000;
type DriveR2 = {
  getPresignedPutUrl(key: string, size: number, expiresIn?: number): Promise<string>;
  getPresignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  getObject(key: string, options?: { signal?: AbortSignal }): Promise<{ body: unknown; contentLength?: number }>;
  deleteObject(key: string): Promise<void>;
};

export type OrganizationDriveErrorCode = "not_found" | "conflict" | "quota" | "checksum" | "unavailable";
export class OrganizationDriveError extends Error {
  constructor(readonly code: OrganizationDriveErrorCode) { super(code); }
}

type DriveIdentity = { organizationId: string; scopeId: string; authorityRuntimeId?: string; authorityGeneration?: number };
type UploadIdentity = DriveIdentity & { actorId: string };
type UploadRow = Selectable<OrganizationDriveUploadsTable>;

/** One selected owner home owns the index. Every route must authorize its scope before calling this service. */
export class OrganizationDriveService {
  constructor(private readonly options: {
    db: Kysely<OrganizationDriveDatabase>;
    r2: DriveR2;
    ownerId: string;
    runtimeSlot: string;
    now?: () => Date;
  }) {}

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private assertGeneration(input: DriveIdentity, drive: { authority_runtime_id: string; authority_generation: number | string }): void {
    if ((input.authorityRuntimeId && drive.authority_runtime_id !== input.authorityRuntimeId)
      || (input.authorityGeneration && Number(drive.authority_generation) !== input.authorityGeneration)) {
      throw new OrganizationDriveError("conflict");
    }
  }

  private async drive(input: DriveIdentity) {
    const drive = await this.options.db.selectFrom("organization_drives").selectAll()
      .where("organization_id", "=", input.organizationId).where("scope_id", "=", input.scopeId).executeTakeFirst();
    if (!drive) throw new OrganizationDriveError("not_found");
    this.assertGeneration(input, drive);
    return drive;
  }

  async enable(input: DriveIdentity & { runtimeId: string; generation: number; quotaBytes?: number }): Promise<void> {
    const now = this.now().toISOString();
    await this.options.db.insertInto("organization_drives").values({
      organization_id: input.organizationId, scope_id: input.scopeId, authority_runtime_id: input.runtimeId,
      authority_generation: input.generation, quota_bytes: input.quotaBytes ?? 1_000_000_000_000,
      used_bytes: 0, reserved_bytes: 0, created_at: now, updated_at: now,
    }).onConflict((conflict) => conflict.column("organization_id").doNothing()).execute();
    const drive = await this.drive(input);
    if (drive.authority_runtime_id !== input.runtimeId || Number(drive.authority_generation) !== input.generation) {
      throw new OrganizationDriveError("conflict");
    }
  }

  async usage(input: DriveIdentity): Promise<{ usedBytes: number; reservedBytes: number; quotaBytes: number }> {
    const row = await this.drive(input);
    return { usedBytes: Number(row.used_bytes), reservedBytes: Number(row.reserved_bytes), quotaBytes: Number(row.quota_bytes) };
  }

  async list(input: DriveIdentity): Promise<OrganizationDriveFile[]> {
    await this.drive(input);
    const rows = await this.options.db.selectFrom("organization_drive_files as f")
      .innerJoin("organization_drive_versions as v", (join) => join.onRef("v.file_id", "=", "f.id")
        .onRef("v.version", "=", "f.current_version"))
      .select(["f.id", "f.organization_id", "f.path", "f.current_version", "v.size_bytes", "v.sha256", "v.created_by", "f.updated_at"])
      .where("f.organization_id", "=", input.organizationId).where("f.deleted_at", "is", null)
      .orderBy("f.path", "asc").limit(1001).execute();
    if (rows.length > 1000) throw new OrganizationDriveError("unavailable");
    return rows.map((row) => OrganizationDriveFileSchema.parse({
      id: row.id, organizationId: row.organization_id, path: row.path,
      version: row.current_version, size: Number(row.size_bytes), sha256: row.sha256,
      updatedBy: row.created_by, updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async reserve(input: UploadIdentity & { request: OrganizationDriveUploadRequest }): Promise<{ uploadId: string; putUrl: string; expiresAt: string }> {
    const request = OrganizationDriveUploadRequestSchema.parse(input.request);
    if (request.size > MAX_FILE_BYTES) throw new OrganizationDriveError("quota");
    const now = this.now();
    const candidateId = randomUUID();
    const objectKey = buildFileKey(resolveSyncScope({ ownerId: this.options.ownerId, runtimeSlot: this.options.runtimeSlot }),
      `.organization-drive/${input.organizationId}/objects/${candidateId}`);
    const row = await this.options.db.transaction().execute(async (trx) => {
      const drive = await trx.selectFrom("organization_drives").selectAll()
        .where("organization_id", "=", input.organizationId).where("scope_id", "=", input.scopeId).forUpdate().executeTakeFirst();
      if (!drive) throw new OrganizationDriveError("not_found");
      this.assertGeneration(input, drive);
      const existing = await trx.selectFrom("organization_drive_uploads").selectAll()
        .where("organization_id", "=", input.organizationId).where("actor_id", "=", input.actorId)
        .where("request_id", "=", request.requestId).executeTakeFirst();
      if (existing) {
        if (existing.path !== request.path || Number(existing.size_bytes) !== request.size || existing.sha256 !== request.sha256
          || existing.base_version !== (request.baseVersion ?? 0) || existing.status !== "pending"
          || new Date(existing.expires_at).getTime() <= now.getTime()) throw new OrganizationDriveError("conflict");
        return existing;
      }
      const file = await trx.selectFrom("organization_drive_files").select(["current_version"])
        .where("organization_id", "=", input.organizationId).where("path", "=", request.path)
        .where("deleted_at", "is", null).executeTakeFirst();
      if ((file?.current_version ?? 0) !== (request.baseVersion ?? 0)) throw new OrganizationDriveError("conflict");
      const reserved = await trx.updateTable("organization_drives").set({
        reserved_bytes: sql<number>`reserved_bytes + ${request.size}`, updated_at: now.toISOString(),
      }).where("organization_id", "=", input.organizationId)
        .where(sql<boolean>`used_bytes + reserved_bytes + ${request.size} <= quota_bytes`)
        .returning("organization_id").executeTakeFirst();
      if (!reserved) throw new OrganizationDriveError("quota");
      const expiry = new Date(now.getTime() + UPLOAD_TTL_MS).toISOString();
      await trx.insertInto("organization_drive_uploads").values({
        id: candidateId, organization_id: input.organizationId, actor_id: input.actorId,
        request_id: request.requestId, path: request.path, base_version: request.baseVersion ?? 0,
        object_key: objectKey, size_bytes: request.size, sha256: request.sha256,
        status: "pending", expires_at: expiry, committed_file_id: null,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      }).execute();
      return { id: candidateId, object_key: objectKey, expires_at: expiry };
    });
    try {
      return { uploadId: row.id, putUrl: await this.options.r2.getPresignedPutUrl(row.object_key, request.size, 900),
        expiresAt: new Date(row.expires_at).toISOString() };
    } catch (error: unknown) {
      console.warn("[organization-drive] upload URL unavailable", error instanceof Error ? error.name : "UnknownError");
      if (row.id === candidateId) {
        await this.abort({ ...input, uploadId: row.id }).catch((cleanupError: unknown) => {
          console.warn("[organization-drive] failed reservation cleanup", cleanupError instanceof Error ? cleanupError.name : "UnknownError");
        });
      }
      throw new OrganizationDriveError("unavailable");
    }
  }

  async commit(input: UploadIdentity & { uploadId: string; revalidate?: () => Promise<void> }): Promise<OrganizationDriveFile> {
    await this.drive(input);
    const upload = await this.upload(input);
    if (upload.status === "committed") return this.fileById(input.organizationId, upload.committed_file_id!);
    if (upload.status !== "pending" || new Date(upload.expires_at).getTime() <= this.now().getTime()) {
      throw new OrganizationDriveError("conflict");
    }
    const verified = await this.verifyObject(upload);
    if (!verified) {
      await this.abort(input);
      throw new OrganizationDriveError("checksum");
    }
    await input.revalidate?.();
    try {
      return await this.options.db.transaction().execute(async (trx) => {
        const drive = await trx.selectFrom("organization_drives").selectAll()
          .where("organization_id", "=", input.organizationId).where("scope_id", "=", input.scopeId).forUpdate().executeTakeFirst();
        if (!drive) throw new OrganizationDriveError("not_found");
        this.assertGeneration(input, drive);
        const current = await trx.selectFrom("organization_drive_uploads").selectAll().where("id", "=", input.uploadId)
          .forUpdate().executeTakeFirst();
        if (!current || current.actor_id !== input.actorId || current.organization_id !== input.organizationId) {
          throw new OrganizationDriveError("not_found");
        }
        if (current.status === "committed") return this.fileById(input.organizationId, current.committed_file_id!, trx);
        if (current.status !== "pending" || new Date(current.expires_at).getTime() <= this.now().getTime()) {
          throw new OrganizationDriveError("conflict");
        }
        const file = await trx.selectFrom("organization_drive_files").select(["id", "current_version"])
          .where("organization_id", "=", input.organizationId).where("path", "=", current.path)
          .where("deleted_at", "is", null).forUpdate().executeTakeFirst();
        if ((file?.current_version ?? 0) !== current.base_version) throw new OrganizationDriveError("conflict");
        const fileId = file?.id ?? randomUUID();
        const nextVersion = (file?.current_version ?? 0) + 1;
        const timestamp = this.now().toISOString();
        if (file) {
          await trx.updateTable("organization_drive_files").set({ current_version: nextVersion, updated_at: timestamp })
            .where("id", "=", fileId).where("current_version", "=", current.base_version).executeTakeFirstOrThrow();
        } else {
          await trx.insertInto("organization_drive_files").values({ id: fileId, organization_id: input.organizationId,
            path: current.path, current_version: nextVersion, deleted_at: null, created_at: timestamp, updated_at: timestamp }).execute();
        }
        await trx.insertInto("organization_drive_versions").values({ id: randomUUID(), file_id: fileId,
          version: nextVersion, object_key: current.object_key, size_bytes: current.size_bytes,
          sha256: current.sha256, created_by: input.actorId, created_at: timestamp }).execute();
        await trx.updateTable("organization_drive_uploads").set({ status: "committed", committed_file_id: fileId,
          updated_at: timestamp }).where("id", "=", current.id).execute();
        const accounted = await trx.updateTable("organization_drives").set({
          used_bytes: sql<number>`used_bytes + ${Number(current.size_bytes)}`,
          reserved_bytes: sql<number>`reserved_bytes - ${Number(current.size_bytes)}`, updated_at: timestamp,
        }).where("organization_id", "=", input.organizationId)
          .where("reserved_bytes", ">=", Number(current.size_bytes))
          .returning("organization_id").executeTakeFirst();
        if (!accounted) throw new OrganizationDriveError("conflict");
        return this.fileById(input.organizationId, fileId, trx);
      });
    } catch (error: unknown) {
      if (error instanceof OrganizationDriveError) throw error;
      if (error instanceof Error && "code" in error && error.code === "23505") throw new OrganizationDriveError("conflict");
      console.warn("[organization-drive] commit failed", error instanceof Error ? error.name : "UnknownError");
      throw new OrganizationDriveError("unavailable");
    }
  }

  async get(input: DriveIdentity & { fileId: string }): Promise<{ file: OrganizationDriveFile; getUrl: string }> {
    const file = await this.fileById(input.organizationId, input.fileId);
    await this.drive(input);
    const version = await this.options.db.selectFrom("organization_drive_versions as v")
      .innerJoin("organization_drive_files as f", "f.id", "v.file_id")
      .select("v.object_key").where("f.id", "=", input.fileId)
      .whereRef("v.version", "=", "f.current_version").executeTakeFirstOrThrow();
    return { file, getUrl: await this.options.r2.getPresignedGetUrl(version.object_key, 60) };
  }

  async abort(input: UploadIdentity & { uploadId: string }): Promise<void> {
    await this.options.db.transaction().execute(async (trx) => {
      const drive = await trx.selectFrom("organization_drives").selectAll()
        .where("organization_id", "=", input.organizationId).where("scope_id", "=", input.scopeId).forUpdate().executeTakeFirst();
      if (!drive) throw new OrganizationDriveError("not_found");
      this.assertGeneration(input, drive);
      const upload = await trx.selectFrom("organization_drive_uploads").selectAll()
        .where("id", "=", input.uploadId).where("organization_id", "=", input.organizationId)
        .where("actor_id", "=", input.actorId).forUpdate().executeTakeFirst();
      if (!upload) throw new OrganizationDriveError("not_found");
      if (upload.status !== "pending") return;
      const timestamp = this.now().toISOString();
      await trx.updateTable("organization_drive_uploads").set({ status: "aborted", updated_at: timestamp })
        .where("id", "=", upload.id).execute();
      const accounted = await trx.updateTable("organization_drives")
        .set({ reserved_bytes: sql<number>`reserved_bytes - ${Number(upload.size_bytes)}`, updated_at: timestamp })
        .where("organization_id", "=", input.organizationId)
        .where("reserved_bytes", ">=", Number(upload.size_bytes))
        .returning("organization_id").executeTakeFirst();
      if (!accounted) throw new OrganizationDriveError("conflict");
      await trx.insertInto("organization_drive_garbage").values({ object_key: upload.object_key,
        organization_id: input.organizationId, remove_after: timestamp, attempts: 0, created_at: timestamp })
        .onConflict((conflict) => conflict.column("object_key").doNothing()).execute();
    });
  }

  /** Recurring bounded cleanup; reservations are released in Postgres before object deletion. */
  async sweep(): Promise<void> {
    const expired = await this.options.db.selectFrom("organization_drive_uploads as u")
      .innerJoin("organization_drives as d", "d.organization_id", "u.organization_id")
      .select(["u.id", "u.organization_id", "u.actor_id", "d.scope_id"])
      .where("u.status", "=", "pending").where("u.expires_at", "<=", this.now().toISOString())
      .orderBy("u.expires_at", "asc").limit(100).execute();
    for (const row of expired) {
      await this.abort({ organizationId: row.organization_id, scopeId: row.scope_id,
        actorId: row.actor_id, uploadId: row.id });
    }
    const garbage = await this.options.db.selectFrom("organization_drive_garbage").selectAll()
      .where("remove_after", "<=", this.now().toISOString()).orderBy("remove_after", "asc").limit(100).execute();
    for (const row of garbage) {
      try {
        await this.options.r2.deleteObject(row.object_key);
        await this.options.db.deleteFrom("organization_drive_garbage").where("object_key", "=", row.object_key).execute();
      } catch (error: unknown) {
        console.warn("[organization-drive] object cleanup failed", error instanceof Error ? error.name : "UnknownError");
        await this.options.db.updateTable("organization_drive_garbage")
          .set({ attempts: row.attempts + 1, remove_after: new Date(this.now().getTime() + 60_000).toISOString() })
          .where("object_key", "=", row.object_key).execute();
      }
    }
  }

  private async upload(input: UploadIdentity & { uploadId: string }): Promise<UploadRow> {
    const row = await this.options.db.selectFrom("organization_drive_uploads").selectAll()
      .where("id", "=", input.uploadId).where("organization_id", "=", input.organizationId)
      .where("actor_id", "=", input.actorId).executeTakeFirst();
    if (!row) throw new OrganizationDriveError("not_found");
    return row;
  }

  private async fileById(organizationId: string, fileId: string, db = this.options.db): Promise<OrganizationDriveFile> {
    const row = await db.selectFrom("organization_drive_files as f")
      .innerJoin("organization_drive_versions as v", (join) => join.onRef("v.file_id", "=", "f.id")
        .onRef("v.version", "=", "f.current_version"))
      .select(["f.id", "f.organization_id", "f.path", "f.current_version", "v.size_bytes", "v.sha256", "v.created_by", "f.updated_at"])
      .where("f.id", "=", fileId).where("f.organization_id", "=", organizationId)
      .where("f.deleted_at", "is", null).executeTakeFirst();
    if (!row) throw new OrganizationDriveError("not_found");
    return OrganizationDriveFileSchema.parse({ id: row.id, organizationId: row.organization_id, path: row.path,
      version: row.current_version, size: Number(row.size_bytes), sha256: row.sha256, updatedBy: row.created_by,
      updatedAt: new Date(row.updated_at).toISOString() });
  }

  private async verifyObject(upload: UploadRow): Promise<boolean> {
    let object: Awaited<ReturnType<DriveR2["getObject"]>>;
    const signal = AbortSignal.timeout(120_000);
    try { object = await this.options.r2.getObject(upload.object_key, { signal }); }
    catch (error: unknown) {
      console.warn("[organization-drive] object verification unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new OrganizationDriveError("unavailable");
    }
    if (!object.body || object.contentLength !== Number(upload.size_bytes)) return false;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of this.objectChunks(object.body, signal)) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > Number(upload.size_bytes) || bytes > MAX_FILE_BYTES) return false;
        hash.update(chunk);
      }
      return bytes === Number(upload.size_bytes) && hash.digest("hex") === upload.sha256;
    } catch (error: unknown) {
      console.warn("[organization-drive] verification stream failed", error instanceof Error ? error.name : "UnknownError");
      throw new OrganizationDriveError("unavailable");
    }
  }

  private async *objectChunks(body: unknown, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const source = body as {
      getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
      destroy?: (error?: Error) => void;
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    };
    if (typeof source.getReader === "function") {
      const reader = source.getReader();
      const cancel = () => { void reader.cancel(signal.reason).catch((error: unknown) => {
        console.warn("[organization-drive] stream cancellation failed", error instanceof Error ? error.name : "UnknownError");
      }); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) return;
          yield part.value;
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch((error: unknown) => {
          console.warn("[organization-drive] stream cleanup failed", error instanceof Error ? error.name : "UnknownError");
        });
        reader.releaseLock();
      }
    }
    if (typeof source[Symbol.asyncIterator] === "function") {
      const cancel = () => source.destroy?.(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for await (const chunk of source as AsyncIterable<unknown>) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new OrganizationDriveError("unavailable");
          yield chunk;
        }
      } finally { signal.removeEventListener("abort", cancel); }
      return;
    }
    throw new OrganizationDriveError("unavailable");
  }
}
