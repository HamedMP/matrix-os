/**
 * S12 / T061: the resource catalog. Files, folders and app instances get a
 * stable id in one owner namespace (owner + optional project); paths change
 * under the id, deleted incarnations are tombstoned and a later file at the
 * same path is a new identity. Standalone scopes reference a catalog id and
 * grant exactly that resource (a folder includes its contents).
 */
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";
import { isSafeCollaborationRelativePath } from "@matrix-os/contracts";

export type CatalogKind = "file" | "folder" | "app";
const MAX_LIST = 100;
const MAX_FOLDER_DELETE = 10_000;
const MAX_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;

export class ResourceCatalogError extends Error {
  constructor(public readonly code: "invalid" | "not_found" | "forbidden" | "conflict" | "unavailable") {
    super("Shared resource is unavailable");
    this.name = "ResourceCatalogError";
  }
}

export interface CatalogEntryRecord {
  id: string;
  ownerId: string;
  projectId: string | null;
  kind: CatalogKind;
  path: string;
  parentId: string | null;
  incarnation: string;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
}

/** The part of an authorized context the catalog needs to bound a lookup. */
export interface CatalogScopeRef {
  resourceKind: "chat" | "terminal" | "project" | "file" | "folder" | "app";
  resourceId: string;
  ownerId: string;
}

export interface CatalogNamespace {
  ownerId: string;
  projectId: string | null;
  /** The standalone root entry; null for a project scope. */
  root: CatalogEntryRecord | null;
}

type Executor = Kysely<OwnerCollaborationDatabase> | Transaction<OwnerCollaborationDatabase>;

function toRecord(row: {
  id: string; owner_id: string; project_id: string | null; kind: CatalogKind; path: string; parent_id: string | null;
  incarnation: string; revision: number | string; updated_at: Date | string; deleted_at: Date | string | null;
}): CatalogEntryRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    kind: row.kind,
    path: row.path,
    parentId: row.parent_id,
    incarnation: row.incarnation,
    revision: Number(row.revision),
    updatedAt: new Date(row.updated_at).toISOString(),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
  };
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

function within(entry: { path: string }, root: CatalogEntryRecord): boolean {
  return entry.path === root.path || entry.path.startsWith(`${root.path}/`);
}

export class CollaborationResourceCatalog {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    readonly db: Kysely<OwnerCollaborationDatabase>,
    options: { now?: () => Date; createId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  /** Idempotent by live (owner, project, kind, path); a tombstoned path yields a fresh id. */
  async register(input: {
    ownerId: string;
    projectId: string | null;
    kind: CatalogKind;
    path: string;
    incarnation: string;
    executor?: Executor;
  }): Promise<CatalogEntryRecord> {
    if (!isSafeCollaborationRelativePath(input.path)) throw new ResourceCatalogError("invalid");
    const executor = input.executor ?? this.db;
    const existing = await this.findLive(executor, input.ownerId, input.projectId, input.kind, input.path);
    if (existing) return existing;
    const parent = input.kind === "app" ? null : await this.parentFor(executor, input.ownerId, input.projectId, input.path);
    const timestamp = this.now();
    await sql`
      INSERT INTO collaboration_resource_catalog
        (id, owner_id, project_id, kind, path, parent_id, incarnation, revision, created_at, updated_at, deleted_at)
      VALUES (${this.createId()}, ${input.ownerId}, ${input.projectId}, ${input.kind}, ${input.path},
        ${parent?.id ?? null}, ${input.incarnation}, 0, ${timestamp}, ${timestamp}, NULL)
      ON CONFLICT (owner_id, COALESCE(project_id, ''), kind, path) WHERE deleted_at IS NULL DO NOTHING
    `.execute(executor);
    const created = await this.findLive(executor, input.ownerId, input.projectId, input.kind, input.path);
    if (!created) throw new ResourceCatalogError("unavailable");
    return created;
  }

  /** Any incarnation, including tombstones; used only to replay a recorded operation. */
  async getAny(id: string, executor: Executor = this.db): Promise<CatalogEntryRecord | null> {
    const row = await executor.selectFrom("collaboration_resource_catalog").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async get(id: string, executor: Executor = this.db): Promise<CatalogEntryRecord | null> {
    const row = await executor.selectFrom("collaboration_resource_catalog").selectAll()
      .where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /** Locks the live row for a write; the caller compares the revision inside the same transaction. */
  async lock(trx: Transaction<OwnerCollaborationDatabase>, id: string): Promise<CatalogEntryRecord> {
    const row = await trx.selectFrom("collaboration_resource_catalog").selectAll()
      .where("id", "=", id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!row) throw new ResourceCatalogError("not_found");
    return toRecord(row);
  }

  /** Conditional bump: `WHERE revision = expected` is the optimistic concurrency check. */
  async bump(
    executor: Executor,
    input: { id: string; expectedRevision: number; incarnation?: string; path?: string; parentId?: string | null },
  ): Promise<CatalogEntryRecord> {
    const timestamp = this.now();
    const row = await executor.updateTable("collaboration_resource_catalog").set({
      revision: input.expectedRevision + 1,
      updated_at: timestamp,
      ...(input.incarnation !== undefined ? { incarnation: input.incarnation } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
    }).where("id", "=", input.id).where("revision", "=", input.expectedRevision).where("deleted_at", "is", null)
      .returningAll().executeTakeFirst();
    if (!row) throw new ResourceCatalogError("conflict");
    return toRecord(row);
  }

  async rename(input: { id: string; path: string; expectedRevision: number; incarnation: string; executor?: Executor }): Promise<CatalogEntryRecord> {
    if (!isSafeCollaborationRelativePath(input.path)) throw new ResourceCatalogError("invalid");
    const executor = input.executor ?? this.db;
    const entry = await this.get(input.id, executor);
    if (!entry) throw new ResourceCatalogError("not_found");
    if (entry.kind === "app") throw new ResourceCatalogError("invalid");
    const clash = await this.findLive(executor, entry.ownerId, entry.projectId, entry.kind, input.path);
    if (clash && clash.id !== entry.id) throw new ResourceCatalogError("conflict");
    const parent = await this.parentFor(executor, entry.ownerId, entry.projectId, input.path);
    const renamed = await this.bump(executor, {
      id: entry.id, expectedRevision: input.expectedRevision, incarnation: input.incarnation, path: input.path, parentId: parent?.id ?? null,
    });
    if (entry.kind === "folder") await this.moveDescendants(executor, entry, input.path);
    return renamed;
  }

  /** Tombstones the entry (and a folder's live descendants); the id never resolves again. */
  async remove(input: { id: string; expectedRevision: number; executor?: Executor }): Promise<CatalogEntryRecord> {
    const executor = input.executor ?? this.db;
    const entry = await this.get(input.id, executor);
    if (!entry) throw new ResourceCatalogError("not_found");
    const timestamp = this.now();
    const row = await executor.updateTable("collaboration_resource_catalog")
      .set({ revision: input.expectedRevision + 1, updated_at: timestamp, deleted_at: timestamp })
      .where("id", "=", entry.id).where("revision", "=", input.expectedRevision).where("deleted_at", "is", null)
      .returningAll().executeTakeFirst();
    if (!row) throw new ResourceCatalogError("conflict");
    if (entry.kind === "folder") {
      const descendants = await this.liveWhere(executor, entry.ownerId, entry.projectId)
        .where("path", "like", `${escapeLike(entry.path)}/%`).select("id").limit(MAX_FOLDER_DELETE + 1).execute();
      if (descendants.length > MAX_FOLDER_DELETE) throw new ResourceCatalogError("conflict");
      if (descendants.length > 0) {
        await executor.updateTable("collaboration_resource_catalog").set({ updated_at: timestamp, deleted_at: timestamp })
          .where("id", "in", descendants.map((row) => row.id)).where("deleted_at", "is", null).execute();
      }
    }
    return toRecord(row);
  }

  /** The namespace a scope reaches: the whole project, or exactly the standalone root. */
  async namespaceForScope(scope: CatalogScopeRef, executor: Executor = this.db): Promise<CatalogNamespace> {
    if (scope.resourceKind === "project") return { ownerId: scope.ownerId, projectId: scope.resourceId, root: null };
    if (scope.resourceKind !== "file" && scope.resourceKind !== "folder" && scope.resourceKind !== "app") {
      throw new ResourceCatalogError("not_found");
    }
    const root = await this.get(scope.resourceId, executor);
    if (!root || root.ownerId !== scope.ownerId || root.kind !== scope.resourceKind) throw new ResourceCatalogError("not_found");
    return { ownerId: root.ownerId, projectId: root.projectId, root };
  }

  /** Resolves an id inside the scope's namespace; anything outside is not found, never forbidden. */
  async resolveForScope(scope: CatalogScopeRef, id: string, executor: Executor = this.db): Promise<CatalogEntryRecord> {
    const namespace = await this.namespaceForScope(scope, executor);
    const entry = await this.get(id, executor);
    if (!entry || !this.contains(namespace, entry)) throw new ResourceCatalogError("not_found");
    return entry;
  }

  contains(namespace: CatalogNamespace, entry: CatalogEntryRecord): boolean {
    if (entry.ownerId !== namespace.ownerId || entry.projectId !== namespace.projectId) return false;
    if (!namespace.root) return true;
    if (namespace.root.kind === "folder") return entry.kind !== "app" && within(entry, namespace.root);
    return entry.id === namespace.root.id;
  }

  async listForScope(
    scope: CatalogScopeRef,
    input: { cursor?: string; limit?: number; query?: string },
    executor: Executor = this.db,
  ): Promise<{ entries: CatalogEntryRecord[]; nextCursor?: string }> {
    const namespace = await this.namespaceForScope(scope, executor);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_LIST);
    let query = this.liveWhere(executor, namespace.ownerId, namespace.projectId).selectAll()
      .where("kind", "!=", "app").orderBy("path", "asc").limit(limit + 1);
    if (namespace.root) {
      query = namespace.root.kind === "folder"
        ? query.where((eb) => eb.or([eb("path", "=", namespace.root!.path), eb("path", "like", `${escapeLike(namespace.root!.path)}/%`)]))
        : query.where("id", "=", namespace.root.id);
    }
    if (input.cursor !== undefined) query = query.where("path", ">", input.cursor);
    if (input.query !== undefined) query = query.where("path", "ilike", `%${escapeLike(input.query)}%`);
    const rows = await query.execute();
    const entries = rows.slice(0, limit).map(toRecord);
    return rows.length > limit ? { entries, nextCursor: entries[entries.length - 1]!.path } : { entries };
  }

  /** A new child inside the scope: the parent must be reachable and the path must be its direct child. */
  async createWithin(
    scope: CatalogScopeRef,
    input: { kind: "file" | "folder"; parentId: string | null; path: string; incarnation: string },
    executor: Executor = this.db,
  ): Promise<CatalogEntryRecord> {
    if (!isSafeCollaborationRelativePath(input.path)) throw new ResourceCatalogError("invalid");
    const namespace = await this.namespaceForScope(scope, executor);
    if (namespace.root && namespace.root.kind !== "folder") throw new ResourceCatalogError("forbidden");
    const parent = input.parentId === null ? null : await this.get(input.parentId, executor);
    if (input.parentId !== null && (!parent || parent.kind !== "folder" || !this.contains(namespace, parent))) {
      throw new ResourceCatalogError("not_found");
    }
    if (namespace.root && !parent) throw new ResourceCatalogError("not_found");
    if (parentPath(input.path) !== (parent?.path ?? null)) throw new ResourceCatalogError("invalid");
    const clash = await this.findLive(executor, namespace.ownerId, namespace.projectId, input.kind, input.path);
    if (clash) throw new ResourceCatalogError("conflict");
    return this.register({ ownerId: namespace.ownerId, projectId: namespace.projectId, kind: input.kind, path: input.path, incarnation: input.incarnation, executor });
  }

  private liveWhere(executor: Executor, ownerId: string, projectId: string | null) {
    const base = executor.selectFrom("collaboration_resource_catalog").where("owner_id", "=", ownerId).where("deleted_at", "is", null);
    return projectId === null ? base.where("project_id", "is", null) : base.where("project_id", "=", projectId);
  }

  private async findLive(executor: Executor, ownerId: string, projectId: string | null, kind: CatalogKind, path: string) {
    const row = await this.liveWhere(executor, ownerId, projectId).selectAll().where("kind", "=", kind).where("path", "=", path).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  private async parentFor(executor: Executor, ownerId: string, projectId: string | null, path: string) {
    const parent = parentPath(path);
    return parent === null ? null : this.findLive(executor, ownerId, projectId, "folder", parent);
  }

  private async moveDescendants(executor: Executor, folder: CatalogEntryRecord, newPath: string): Promise<void> {
    const timestamp = this.now();
    await sql`
      UPDATE collaboration_resource_catalog
      SET path = ${newPath} || substr(path, ${folder.path.length + 1}), updated_at = ${timestamp}
      WHERE owner_id = ${folder.ownerId} AND project_id IS NOT DISTINCT FROM ${folder.projectId}
        AND deleted_at IS NULL AND path LIKE ${`${escapeLike(folder.path)}/%`}
    `.execute(executor);
  }
}

export function uploadExpiry(now: Date): Date {
  return new Date(now.getTime() + MAX_UPLOAD_TTL_MS);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Gateway migration 12: catalog, upload staging, and the widened scope/event kinds. */
export async function migrateResourceCatalogV12(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  for (const table of ["collaboration_scopes"]) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT IF EXISTS ${sql.id(`${table}_kind_check`)}`.execute(trx);
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.id(`${table}_kind_check`)}
      CHECK (kind IN ('chat', 'terminal', 'project', 'file', 'folder', 'app'))`.execute(trx);
  }
  for (const table of ["collaboration_events", "collaboration_directory_outbox"]) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT IF EXISTS ${sql.id(`${table}_resource_kind_check`)}`.execute(trx);
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.id(`${table}_resource_kind_check`)}
      CHECK (resource_kind IN ('chat', 'terminal', 'project', 'file', 'folder', 'app'))`.execute(trx);
  }
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_resource_catalog (
      id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      project_id TEXT CHECK (project_id IS NULL OR (char_length(project_id) BETWEEN 1 AND 256 AND project_id ~ '^[A-Za-z0-9_-]+$')),
      kind TEXT NOT NULL CHECK (kind IN ('file', 'folder', 'app')),
      path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 4096),
      parent_id UUID REFERENCES collaboration_resource_catalog(id),
      incarnation TEXT NOT NULL CHECK (char_length(incarnation) BETWEEN 1 AND 256),
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    )
  `.execute(trx);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_resource_catalog_live
      ON collaboration_resource_catalog(owner_id, COALESCE(project_id, ''), kind, path) WHERE deleted_at IS NULL
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_resource_catalog_namespace
      ON collaboration_resource_catalog(owner_id, project_id, path) WHERE deleted_at IS NULL
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_upload_stages (
      id UUID PRIMARY KEY,
      scope_id UUID NOT NULL REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
      catalog_id UUID REFERENCES collaboration_resource_catalog(id),
      parent_id UUID REFERENCES collaboration_resource_catalog(id),
      path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 4096),
      size BIGINT NOT NULL CHECK (size >= 0),
      sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      received_bytes BIGINT NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
      next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
      state TEXT NOT NULL CHECK (state IN ('staging', 'committed', 'cancelled', 'expired')),
      staging_ref TEXT NOT NULL CHECK (char_length(staging_ref) BETWEEN 1 AND 512),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_upload_stages_scope
      ON collaboration_upload_stages(scope_id, state, expires_at)
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version) VALUES (12) ON CONFLICT DO NOTHING`.execute(trx);
}
