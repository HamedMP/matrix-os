import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod/v4";

import type { CollaborationAppBindingsTable, OwnerCollaborationDatabase } from "./database.js";

const OwnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface CollaborativeAppBindingRecord {
  scopeId: string;
  catalogId: string;
  registrationIncarnation: string;
  readinessId: string;
  buildId: string;
  dataRevision: number;
  state: "active" | "needs_recheck" | "stopped";
  revision: number;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
}

export class CollaborativeAppShareRepositoryError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "unavailable") {
    super("Collaborative app share is unavailable");
    this.name = "CollaborativeAppShareRepositoryError";
  }
}

type BindingRow = Selectable<CollaborationAppBindingsTable>;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toRecord(row: BindingRow): CollaborativeAppBindingRecord {
  return {
    scopeId: row.scope_id,
    catalogId: row.catalog_id,
    registrationIncarnation: row.registration_incarnation,
    readinessId: row.readiness_id,
    buildId: row.build_id,
    dataRevision: Number(row.data_revision),
    state: row.state,
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    stoppedAt: iso(row.stopped_at),
  };
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function mapWriteError(error: unknown): CollaborativeAppShareRepositoryError {
  if (error instanceof CollaborativeAppShareRepositoryError) return error;
  const code = (error as { code?: unknown }).code;
  if (code === "23505" || code === "23503" || code === "23514") {
    return new CollaborativeAppShareRepositoryError("conflict");
  }
  console.warn("[collaborative-app-share] persistence failed", error instanceof Error ? error.name : "UnknownError");
  return new CollaborativeAppShareRepositoryError("unavailable");
}

export class CollaborativeAppShareRepository {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: {
    scopeId: string;
    ownerId: string;
    readinessId: string;
    expectedBuildId: string;
  }): Promise<CollaborativeAppBindingRecord> {
    const scopeId = z.uuid().safeParse(input.scopeId);
    const ownerId = OwnerIdSchema.safeParse(input.ownerId);
    const readinessId = z.uuid().safeParse(input.readinessId);
    const buildId = DigestSchema.safeParse(input.expectedBuildId);
    if (!scopeId.success || !ownerId.success || !readinessId.success || !buildId.success) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    const timestamp = this.now();
    try {
      await sql`
        INSERT INTO collaboration_app_bindings (
          scope_id, catalog_id, registration_incarnation, readiness_id, build_id,
          data_revision, state, revision, created_at, updated_at, stopped_at
        )
        SELECT scope.id, catalog.id, catalog.incarnation, readiness.id, readiness.build_id,
          0, 'active', 1, ${timestamp}, ${timestamp}, NULL
        FROM collaboration_scopes scope
        JOIN collaboration_resource_catalog catalog
          ON catalog.id::text = scope.resource_id
          AND catalog.deleted_at IS NULL
          AND catalog.kind = 'app'
        JOIN collaboration_app_readiness readiness
          ON readiness.id = ${readinessId.data}
          AND readiness.owner_id = ${ownerId.data}
          AND readiness.catalog_id = catalog.id
          AND readiness.registration_incarnation = catalog.incarnation
          AND readiness.build_id = ${buildId.data}
          AND readiness.status = 'ready'
          AND readiness.invalidated_at IS NULL
        WHERE scope.id = ${scopeId.data}
          AND scope.owner_id = ${ownerId.data}
          AND scope.kind = 'app'
          AND scope.resource_id = catalog.id::text
          AND scope.membership_mode = 'direct'
          AND scope.lifecycle = 'shared'
          AND scope.deleted_at IS NULL
        ON CONFLICT (scope_id) DO NOTHING
      `.execute(this.db);
      const row = await this.db.selectFrom("collaboration_app_bindings").selectAll()
        .where("scope_id", "=", scopeId.data).executeTakeFirst();
      if (!row || row.readiness_id !== readinessId.data || row.build_id !== buildId.data || row.state === "stopped") {
        throw new CollaborativeAppShareRepositoryError("conflict");
      }
      return toRecord(row);
    } catch (error: unknown) {
      throw mapWriteError(error);
    }
  }

  async advanceDataRevision(input: {
    scopeId: string;
    ownerId: string;
    expectedBindingRevision: number;
    expectedDataRevision: number;
  }): Promise<CollaborativeAppBindingRecord> {
    if (!z.uuid().safeParse(input.scopeId).success || !OwnerIdSchema.safeParse(input.ownerId).success
      || !validRevision(input.expectedBindingRevision) || input.expectedBindingRevision < 1
      || !validRevision(input.expectedDataRevision)) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    const result = await sql<BindingRow>`
      UPDATE collaboration_app_bindings binding
      SET data_revision = binding.data_revision + 1,
          revision = binding.revision + 1,
          updated_at = ${this.now()}
      FROM collaboration_scopes scope
      WHERE binding.scope_id = ${input.scopeId}
        AND scope.id = binding.scope_id
        AND scope.owner_id = ${input.ownerId}
        AND scope.deleted_at IS NULL
        AND binding.state <> 'stopped'
        AND binding.revision = ${input.expectedBindingRevision}
        AND binding.data_revision = ${input.expectedDataRevision}
      RETURNING binding.*
    `.execute(this.db);
    const row = result.rows[0];
    if (!row) throw new CollaborativeAppShareRepositoryError("conflict");
    return toRecord(row);
  }

  async rebind(input: {
    scopeId: string;
    ownerId: string;
    expectedRevision: number;
    readinessId: string;
    expectedBuildId: string;
  }): Promise<CollaborativeAppBindingRecord> {
    if (!z.uuid().safeParse(input.scopeId).success || !OwnerIdSchema.safeParse(input.ownerId).success
      || !z.uuid().safeParse(input.readinessId).success || !DigestSchema.safeParse(input.expectedBuildId).success
      || !validRevision(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    const result = await sql<BindingRow>`
      UPDATE collaboration_app_bindings binding
      SET readiness_id = readiness.id,
          build_id = readiness.build_id,
          state = 'active',
          revision = binding.revision + 1,
          updated_at = ${this.now()},
          stopped_at = NULL
      FROM collaboration_scopes scope,
           collaboration_resource_catalog catalog,
           collaboration_app_readiness readiness
      WHERE binding.scope_id = ${input.scopeId}
        AND binding.revision = ${input.expectedRevision}
        AND binding.state <> 'stopped'
        AND scope.id = binding.scope_id
        AND scope.owner_id = ${input.ownerId}
        AND scope.deleted_at IS NULL
        AND catalog.id = binding.catalog_id
        AND catalog.deleted_at IS NULL
        AND catalog.incarnation = binding.registration_incarnation
        AND readiness.id = ${input.readinessId}
        AND readiness.owner_id = ${input.ownerId}
        AND readiness.catalog_id = binding.catalog_id
        AND readiness.registration_incarnation = binding.registration_incarnation
        AND readiness.build_id = ${input.expectedBuildId}
        AND readiness.status = 'ready'
        AND readiness.invalidated_at IS NULL
      RETURNING binding.*
    `.execute(this.db);
    const row = result.rows[0];
    if (!row) throw new CollaborativeAppShareRepositoryError("conflict");
    return toRecord(row);
  }

  async stop(input: { scopeId: string; ownerId: string; expectedRevision: number }): Promise<CollaborativeAppBindingRecord> {
    if (!z.uuid().safeParse(input.scopeId).success || !OwnerIdSchema.safeParse(input.ownerId).success
      || !validRevision(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    const timestamp = this.now();
    const result = await sql<BindingRow>`
      UPDATE collaboration_app_bindings binding
      SET state = 'stopped',
          revision = binding.revision + 1,
          updated_at = ${timestamp},
          stopped_at = ${timestamp}
      FROM collaboration_scopes scope
      WHERE binding.scope_id = ${input.scopeId}
        AND binding.revision = ${input.expectedRevision}
        AND binding.state <> 'stopped'
        AND scope.id = binding.scope_id
        AND scope.owner_id = ${input.ownerId}
        AND scope.deleted_at IS NULL
      RETURNING binding.*
    `.execute(this.db);
    const row = result.rows[0];
    if (!row) throw new CollaborativeAppShareRepositoryError("conflict");
    return toRecord(row);
  }

  async getActiveByCatalog(input: { ownerId: string; catalogId: string }): Promise<CollaborativeAppBindingRecord | null> {
    const row = await this.db.selectFrom("collaboration_app_bindings")
      .innerJoin("collaboration_scopes", "collaboration_scopes.id", "collaboration_app_bindings.scope_id")
      .innerJoin("collaboration_resource_catalog", "collaboration_resource_catalog.id", "collaboration_app_bindings.catalog_id")
      .selectAll("collaboration_app_bindings")
      .where("collaboration_scopes.owner_id", "=", input.ownerId)
      .where("collaboration_app_bindings.catalog_id", "=", input.catalogId)
      .where("collaboration_app_bindings.state", "!=", "stopped")
      .where("collaboration_scopes.deleted_at", "is", null)
      .where("collaboration_resource_catalog.deleted_at", "is", null)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }
}
