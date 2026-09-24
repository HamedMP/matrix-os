/** Bounded, resumable uploads kept in owner Postgres until a fresh home commit. */
import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import {
  COLLABORATION_UPLOAD_PART_BYTES,
  COLLABORATION_UPLOAD_MAX_PARTS,
  type CollaborationFileActionRequest,
  type CollaborationUpload,
} from "@matrix-os/contracts";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationResourceDriver } from "./resource-actions.js";
import { CollaborationResourceCatalog, ResourceCatalogError, uploadExpiry, type CatalogEntryRecord } from "./resource-catalog.js";

export type CollaborationUploadAction = Extract<
  CollaborationFileActionRequest,
  { type: "upload_stage" | "upload_part" | "upload_commit" | "upload_cancel" }
>;
export interface CollaborationUploadResult {
  entry?: CatalogEntryRecord;
  upload?: CollaborationUpload;
  replayed: boolean;
}
export interface CollaborationUploadStager {
  handle(context: AuthorizedCollaborationContext, action: CollaborationUploadAction): Promise<CollaborationUploadResult>;
  sweepExpired(): Promise<number>;
  close(): void;
}

type StageRow = Awaited<ReturnType<typeof lockStage>>;
const MAX_ACTIVE_PER_ACTOR_SCOPE = 4;
const MAX_SIMULTANEOUS_COMMITS = 2;
/** Parts read from Postgres per commit batch: the whole upload never sits in memory. */
const COMMIT_PART_BATCH = 32;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function upload(row: NonNullable<StageRow>): CollaborationUpload {
  return {
    uploadId: row.id,
    state: row.state,
    receivedBytes: Number(row.received_bytes),
    size: Number(row.size),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
/** Yields the staged parts in index order, one bounded batch of rows at a time. */
async function* readParts(
  trx: Transaction<OwnerCollaborationDatabase>,
  uploadId: string,
  expectedParts: number,
): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < expectedParts; start += COMMIT_PART_BATCH) {
    const size = Math.min(COMMIT_PART_BATCH, expectedParts - start);
    const rows = await trx.selectFrom("collaboration_upload_parts").select(["part_index", "bytes"])
      .where("upload_id", "=", uploadId).where("part_index", ">=", start).where("part_index", "<", start + size)
      .orderBy("part_index").execute();
    if (rows.length !== size) throw new ResourceCatalogError("conflict");
    for (const [offset, part] of rows.entries()) {
      if (part.part_index !== start + offset) throw new ResourceCatalogError("conflict");
      yield part.bytes;
    }
  }
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index < 0 ? null : path.slice(0, index);
}
async function lockStage(trx: Transaction<OwnerCollaborationDatabase>, id: string) {
  return trx.selectFrom("collaboration_upload_stages").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
}
function requireStage(row: StageRow, context: AuthorizedCollaborationContext, now: Date): NonNullable<StageRow> {
  if (!row || row.scope_id !== context.scopeId || row.actor_id !== context.actorId) throw new ResourceCatalogError("not_found");
  if (row.state === "staging" && new Date(row.expires_at).getTime() <= now.getTime()) throw new ResourceCatalogError("conflict");
  return row;
}

export function createCollaborationUploadStager(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  catalog: CollaborationResourceCatalog;
  driver: CollaborationResourceDriver;
  now?: () => Date;
  onCommitted?: (scopeId: string) => Promise<void>;
  cleanupIntervalMs?: number;
}): CollaborationUploadStager {
  const now = options.now ?? (() => new Date());
  let activeCommits = 0;
  const timer = setInterval(() => {
    void sweepExpired().catch((error: unknown) => {
      console.warn("[collaboration-upload] sweep failed", error instanceof Error ? error.name : "UnknownError");
    });
  }, options.cleanupIntervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref();

  async function lockCurrentScope(trx: Transaction<OwnerCollaborationDatabase>, context: AuthorizedCollaborationContext) {
    const scope = await trx.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", context.scopeId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!scope || scope.lifecycle !== "shared" || scope.resource_id !== context.resourceId || scope.owner_id !== context.ownerId
      || scope.authority_runtime_id !== context.authorityRuntimeId
      || Number(scope.authority_generation) !== context.authorityGeneration
      || Number(scope.auth_epoch) !== context.authEpoch) throw new ResourceCatalogError("not_found");
    const member = await trx.selectFrom("collaboration_members").select(["status", "role", "expires_at"])
      .where("scope_id", "=", context.membershipScopeId).where("actor_id", "=", context.actorId)
      .forShare().executeTakeFirst();
    if (member && (member.status !== "accepted" || (member.expires_at && new Date(member.expires_at).getTime() <= now().getTime()))) {
      throw new ResourceCatalogError("forbidden");
    }
    if (member && member.role === "viewer") throw new ResourceCatalogError("forbidden");
    return scope;
  }

  async function stage(context: AuthorizedCollaborationContext, action: Extract<CollaborationUploadAction, { type: "upload_stage" }>) {
    return options.db.transaction().execute(async (trx) => {
      await lockCurrentScope(trx, context);
      const previous = await lockStage(trx, action.clientRequestId);
      if (previous) {
        const row = requireStage(previous, context, now());
        if (row.catalog_id !== (action.fileId ?? null) || row.parent_id !== (action.parentId ?? null)
          || Number(row.size) !== action.size || row.sha256 !== action.sha256
          || (action.path !== undefined && row.path !== action.path)) throw new ResourceCatalogError("conflict");
        return { upload: upload(row), replayed: true };
      }
      const count = await trx.selectFrom("collaboration_upload_stages").select(({ fn }) => fn.countAll<number>().as("count"))
        .where("scope_id", "=", context.scopeId).where("actor_id", "=", context.actorId)
        .where("state", "=", "staging").where("expires_at", ">", now()).executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_ACTIVE_PER_ACTOR_SCOPE) throw new ResourceCatalogError("unavailable");
      const namespace = await options.catalog.namespaceForScope(context, trx);
      let path: string;
      if (action.fileId) {
        const file = await options.catalog.resolveForScope(context, action.fileId, trx);
        if (file.kind !== "file") throw new ResourceCatalogError("invalid");
        path = file.path;
      } else {
        if (!action.path || namespace.root?.kind === "file") throw new ResourceCatalogError("forbidden");
        const parent = action.parentId ? await options.catalog.resolveForScope(context, action.parentId, trx) : null;
        if (parent && parent.kind !== "folder") throw new ResourceCatalogError("invalid");
        if (namespace.root && !parent) throw new ResourceCatalogError("not_found");
        if (parentPath(action.path) !== (parent?.path ?? null)) throw new ResourceCatalogError("invalid");
        path = action.path;
      }
      const timestamp = now();
      await trx.insertInto("collaboration_upload_stages").values({
        id: action.clientRequestId, scope_id: context.scopeId, actor_id: context.actorId,
        catalog_id: action.fileId ?? null, parent_id: action.parentId ?? null, path,
        size: action.size, sha256: action.sha256, received_bytes: 0, next_index: 0,
        state: "staging", staging_ref: "postgres_parts_v1", commit_request_id: null, committed_revision: null,
        created_at: timestamp, updated_at: timestamp, expires_at: uploadExpiry(timestamp),
      }).execute();
      const row = await lockStage(trx, action.clientRequestId);
      return { upload: upload(row!), replayed: false };
    });
  }

  async function part(context: AuthorizedCollaborationContext, action: Extract<CollaborationUploadAction, { type: "upload_part" }>) {
    const bytes = Buffer.from(action.chunk, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > COLLABORATION_UPLOAD_PART_BYTES
      || action.index >= COLLABORATION_UPLOAD_MAX_PARTS || bytes.toString("base64") !== action.chunk
      || hash(bytes) !== action.sha256) throw new ResourceCatalogError("invalid");
    return options.db.transaction().execute(async (trx) => {
      await lockCurrentScope(trx, context);
      const row = requireStage(await lockStage(trx, action.uploadId), context, now());
      if (row.state !== "staging") throw new ResourceCatalogError("conflict");
      const next = Number(row.next_index);
      if (action.index < next) {
        const existing = await trx.selectFrom("collaboration_upload_parts").select(["sha256", "bytes"])
          .where("upload_id", "=", row.id).where("part_index", "=", action.index).executeTakeFirst();
        if (!existing || existing.sha256 !== action.sha256 || !Buffer.from(existing.bytes).equals(bytes)) throw new ResourceCatalogError("conflict");
        return { upload: upload(row), replayed: true };
      }
      if (next >= COLLABORATION_UPLOAD_MAX_PARTS || action.index !== next
        || Number(row.received_bytes) + bytes.byteLength > Number(row.size)) throw new ResourceCatalogError("conflict");
      await trx.insertInto("collaboration_upload_parts").values({
        upload_id: row.id, part_index: action.index, sha256: action.sha256, bytes, byte_count: bytes.byteLength,
      }).execute();
      const updated = await trx.updateTable("collaboration_upload_stages").set({
        received_bytes: Number(row.received_bytes) + bytes.byteLength, next_index: next + 1, updated_at: now(),
      }).where("id", "=", row.id).where("next_index", "=", next).returningAll().executeTakeFirst();
      if (!updated) throw new ResourceCatalogError("conflict");
      return { upload: upload(updated), replayed: false };
    });
  }

  async function commit(context: AuthorizedCollaborationContext, action: Extract<CollaborationUploadAction, { type: "upload_commit" }>) {
    if (activeCommits >= MAX_SIMULTANEOUS_COMMITS) throw new ResourceCatalogError("unavailable");
    activeCommits += 1;
    try {
      const result = await options.db.transaction().execute(async (trx) => {
        await lockCurrentScope(trx, context);
        const row = requireStage(await lockStage(trx, action.uploadId), context, now());
        if (row.state === "committed") {
          if (row.commit_request_id !== action.clientRequestId || Number(row.committed_revision) !== Number(action.expectedRevision) + 1
            || !row.catalog_id) throw new ResourceCatalogError("conflict");
          const previous = await options.catalog.getAny(row.catalog_id, trx);
          if (!previous) throw new ResourceCatalogError("conflict");
          return { entry: previous, replayed: true };
        }
        if (row.state !== "staging" || Number(row.received_bytes) !== Number(row.size)) throw new ResourceCatalogError("conflict");
        const expectedParts = Number(row.next_index);
        const stored = await trx.selectFrom("collaboration_upload_parts").select(({ fn }) => fn.countAll<number>().as("count"))
          .where("upload_id", "=", row.id).executeTakeFirstOrThrow();
        if (Number(stored.count) !== expectedParts) throw new ResourceCatalogError("conflict");
        const namespace = await options.catalog.namespaceForScope(context, trx);
        // A commit creates or rewrites a catalog path, so it shares the namespace
        // with other creates and writes and waits behind a folder delete or rename.
        await options.catalog.lockNamespace(trx, namespace, "shared");
        let entry: CatalogEntryRecord;
        if (row.catalog_id) {
          const file = await options.catalog.resolveForScope(context, row.catalog_id, trx);
          if (file.kind !== "file" || file.path !== row.path || file.revision !== Number(action.expectedRevision)) throw new ResourceCatalogError("conflict");
          entry = await options.catalog.lock(trx, file.id);
        } else {
          if (Number(action.expectedRevision) !== 0) throw new ResourceCatalogError("conflict");
          entry = await options.catalog.createWithin(context, {
            kind: "file", parentId: row.parent_id, path: row.path, incarnation: "pending",
          }, trx);
        }
        // The driver hashes the stream and only then renames the file into place,
        // so a contiguous buffer of the whole upload is never built here.
        await options.driver.writeChunks({
          ownerId: namespace.ownerId, projectId: namespace.projectId, path: row.path,
          size: Number(row.size), sha256: row.sha256, chunks: readParts(trx, row.id, expectedParts),
        });
        entry = await options.catalog.bump(trx, {
          id: entry.id, expectedRevision: Number(action.expectedRevision),
          incarnation: await options.driver.fingerprint({ ownerId: namespace.ownerId, projectId: namespace.projectId, path: row.path }),
        });
        await trx.updateTable("collaboration_upload_stages").set({
          state: "committed", catalog_id: entry.id, commit_request_id: action.clientRequestId,
          committed_revision: entry.revision, updated_at: now(),
        }).where("id", "=", row.id).where("state", "=", "staging").execute();
        await trx.deleteFrom("collaboration_upload_parts").where("upload_id", "=", row.id).execute();
        const latest = await trx.selectFrom("collaboration_events").select("scope_seq")
          .where("scope_id", "=", context.scopeId).orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
        await trx.insertInto("collaboration_events").values({
          scope_id: context.scopeId, scope_seq: Number(latest?.scope_seq ?? 0) + 1,
          event_id: randomUUID(), resource_kind: context.resourceKind,
          resource_id: context.resourceKind === "project" ? context.resourceId : entry.id,
          revision: entry.revision, authority_generation: context.authorityGeneration,
          event_type: "resource.upload_committed", payload: JSON.stringify({ catalogId: entry.id }) as unknown as object,
          created_at: now(),
        }).execute();
        await trx.insertInto("collaboration_audit").values({
          scope_id: context.scopeId, actor_id: context.actorId, action: "resource.upload_commit",
          outcome: "completed", revision: entry.revision, reason_code: null, created_at: now(),
        }).execute();
        return { entry, replayed: false };
      });
      if (!result.replayed && options.onCommitted) {
        try {
          await options.onCommitted(context.scopeId);
        } catch (error: unknown) {
          console.warn("[collaboration-upload] committed event delivery failed", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return result;
    } finally {
      activeCommits -= 1;
    }
  }

  async function cancel(context: AuthorizedCollaborationContext, action: Extract<CollaborationUploadAction, { type: "upload_cancel" }>) {
    return options.db.transaction().execute(async (trx) => {
      const row = requireStage(await lockStage(trx, action.uploadId), context, now());
      if (row.state === "committed") throw new ResourceCatalogError("conflict");
      if (row.state === "cancelled" || row.state === "expired") return { upload: upload(row), replayed: true };
      await trx.deleteFrom("collaboration_upload_parts").where("upload_id", "=", row.id).execute();
      const updated = await trx.updateTable("collaboration_upload_stages").set({ state: "cancelled", updated_at: now() })
        .where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
      return { upload: upload(updated), replayed: false };
    });
  }

  async function sweepExpired(): Promise<number> {
    return options.db.transaction().execute(async (trx) => {
      const expired = await trx.selectFrom("collaboration_upload_stages").select("id")
        .where("state", "=", "staging").where("expires_at", "<=", now())
        .limit(100).forUpdate().skipLocked().execute();
      const ids = expired.map((row) => row.id);
      if (ids.length > 0) {
        await trx.deleteFrom("collaboration_upload_parts").where("upload_id", "in", ids).execute();
        await trx.updateTable("collaboration_upload_stages").set({ state: "expired", updated_at: now() })
          .where("id", "in", ids).execute();
      }
      // Keep terminal rows briefly for retry/audit, then bound persistent staging state.
      const obsolete = await trx.selectFrom("collaboration_upload_stages").select("id")
        .where("state", "in", ["committed", "cancelled", "expired"])
        .where("updated_at", "<", new Date(now().getTime() - TERMINAL_RETENTION_MS))
        .limit(100).forUpdate().skipLocked().execute();
      if (obsolete.length > 0) {
        await trx.deleteFrom("collaboration_upload_stages").where("id", "in", obsolete.map((row) => row.id)).execute();
      }
      return ids.length + obsolete.length;
    });
  }

  return {
    handle: (context, action) => {
      switch (action.type) {
        case "upload_stage": return stage(context, action);
        case "upload_part": return part(context, action);
        case "upload_commit": return commit(context, action);
        case "upload_cancel": return cancel(context, action);
      }
    },
    sweepExpired,
    close: () => clearInterval(timer),
  };
}
