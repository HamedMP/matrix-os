import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod/v4";

import type { CollaborationAppBindingsTable, OwnerCollaborationDatabase } from "./database.js";
import { appendMutationRecords, jsonb } from "./repository-shared.js";

const OwnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

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

export interface AtomicCollaborativeAppShareRecord {
  scopeId: string;
  organizationId: string;
  scopeRevision: number;
  authEpoch: number;
  createdAt: string;
  updatedAt: string;
  binding: CollaborativeAppBindingRecord;
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

function toShareRecord(
  scope: {
    id: string;
    organization_id: string | null;
    revision: number | string;
    auth_epoch: number | string;
    created_at: Date | string;
    updated_at: Date | string;
  },
  binding: BindingRow,
): AtomicCollaborativeAppShareRecord {
  if (!scope.organization_id) throw new CollaborativeAppShareRepositoryError("conflict");
  return {
    scopeId: scope.id,
    organizationId: scope.organization_id,
    scopeRevision: Number(scope.revision),
    authEpoch: Number(scope.auth_epoch),
    createdAt: iso(scope.created_at)!,
    updatedAt: iso(scope.updated_at)!,
    binding: toRecord(binding),
  };
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
  private readonly createId: () => string;

  constructor(
    private readonly db: Kysely<OwnerCollaborationDatabase>,
    options: { now?: () => Date; createId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async createAtomic(input: {
    ownerId: string;
    organizationId: string;
    catalogId: string;
    readinessId: string;
    expectedResourceRevision: number;
    expectedReadinessRevision: number;
    expectedBuildId: string;
    clientRequestId: string;
    payloadHash: string;
    runtimeId: string;
  }): Promise<AtomicCollaborativeAppShareRecord> {
    if (!OwnerIdSchema.safeParse(input.ownerId).success
      || !z.string().min(1).max(128).safeParse(input.organizationId).success
      || !z.uuid().safeParse(input.catalogId).success
      || !z.uuid().safeParse(input.readinessId).success
      || !z.uuid().safeParse(input.clientRequestId).success
      || !DigestSchema.safeParse(input.expectedBuildId).success
      || !DigestSchema.safeParse(input.payloadHash).success
      || !RuntimeIdSchema.safeParse(input.runtimeId).success
      || !validRevision(input.expectedResourceRevision)
      || !validRevision(input.expectedReadinessRevision) || input.expectedReadinessRevision < 1) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    try {
      return await this.db.transaction().execute(async (trx) => {
        const catalog = await trx.selectFrom("collaboration_resource_catalog").selectAll()
          .where("id", "=", input.catalogId).where("owner_id", "=", input.ownerId)
          .where("kind", "=", "app").where("revision", "=", input.expectedResourceRevision)
          .where("deleted_at", "is", null).forUpdate().executeTakeFirst();
        if (!catalog) throw new CollaborativeAppShareRepositoryError("conflict");
        const readiness = await trx.selectFrom("collaboration_app_readiness").selectAll()
          .where("id", "=", input.readinessId).where("owner_id", "=", input.ownerId)
          .where("catalog_id", "=", catalog.id).where("registration_incarnation", "=", catalog.incarnation)
          .where("build_id", "=", input.expectedBuildId).where("revision", "=", input.expectedReadinessRevision)
          .where("status", "=", "ready").where("invalidated_at", "is", null)
          .forUpdate().executeTakeFirst();
        if (!readiness) throw new CollaborativeAppShareRepositoryError("conflict");
        const timestamp = this.now();
        const timestampIso = timestamp.toISOString();
        await trx.insertInto("collaboration_scopes").values({
          id: this.createId(), owner_type: "personal", owner_id: input.ownerId,
          organization_id: input.organizationId, kind: "app", resource_id: catalog.id,
          parent_scope_id: null, membership_mode: "direct", lifecycle: "shared", revision: 1,
          auth_epoch: 1, authority_runtime_id: input.runtimeId, authority_generation: 1,
          execution_generation: null, execution_eligibility: null,
          created_at: timestamp, updated_at: timestamp, deleted_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_type", "owner_id", "kind", "resource_id"])
          .where("deleted_at", "is", null).where("lifecycle", "!=", "deleted").doNothing()).execute();
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("owner_type", "=", "personal").where("owner_id", "=", input.ownerId)
          .where("kind", "=", "app").where("resource_id", "=", catalog.id)
          .where("deleted_at", "is", null).where("lifecycle", "!=", "deleted")
          .forUpdate().executeTakeFirstOrThrow();
        if (scope.organization_id !== input.organizationId || scope.lifecycle !== "shared"
          || scope.membership_mode !== "direct" || scope.authority_runtime_id !== input.runtimeId) {
          throw new CollaborativeAppShareRepositoryError("conflict");
        }
        const operation = await trx.selectFrom("collaboration_operations").select(["payload_hash", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId)
          .where("client_request_id", "=", input.clientRequestId)
          .where("operation_kind", "=", "app.share.create").executeTakeFirst();
        if (operation) {
          if (operation.payload_hash !== input.payloadHash || operation.status !== "completed") {
            throw new CollaborativeAppShareRepositoryError("conflict");
          }
          const replay = await trx.selectFrom("collaboration_app_bindings").selectAll()
            .where("scope_id", "=", scope.id).executeTakeFirstOrThrow();
          return toShareRecord(scope, replay);
        }
        await trx.insertInto("collaboration_members").values({
          scope_id: scope.id, actor_id: input.ownerId, organization_id: input.organizationId,
          role: "owner", status: "accepted", invitation_id: null, invited_by: input.ownerId,
          accepted_at: timestamp, expires_at: null, revision: 1, joined_at: timestamp,
          updated_at: timestamp, dispositioned_at: null,
        }).onConflict((conflict) => conflict.columns(["scope_id", "actor_id"]).doNothing()).execute();
        const owner = await trx.selectFrom("collaboration_members").select(["role", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId).executeTakeFirst();
        if (!owner || owner.role !== "owner" || owner.status !== "accepted") {
          throw new CollaborativeAppShareRepositoryError("conflict");
        }
        await trx.insertInto("collaboration_app_bindings").values({
          scope_id: scope.id, catalog_id: catalog.id, registration_incarnation: catalog.incarnation,
          readiness_id: readiness.id, build_id: readiness.build_id, data_revision: 0,
          state: "active", revision: 1, created_at: timestamp, updated_at: timestamp, stopped_at: null,
        }).onConflict((conflict) => conflict.column("scope_id").doNothing()).execute();
        const binding = await trx.selectFrom("collaboration_app_bindings").selectAll()
          .where("scope_id", "=", scope.id).executeTakeFirstOrThrow();
        if (binding.catalog_id !== catalog.id || binding.readiness_id !== readiness.id
          || binding.build_id !== readiness.build_id || binding.state === "stopped") {
          throw new CollaborativeAppShareRepositoryError("conflict");
        }
        await appendMutationRecords(trx, {
          scope, actorId: input.ownerId, action: "app.share.created",
          recipients: [{ actorId: input.ownerId }], discoveryState: "accepted", now: timestampIso,
        });
        await trx.insertInto("collaboration_operations").values({
          scope_id: scope.id, actor_id: input.ownerId, client_request_id: input.clientRequestId,
          operation_kind: "app.share.create", payload_hash: input.payloadHash, status: "completed",
          result_ref: jsonb({ scopeId: scope.id }), expected_revision: input.expectedResourceRevision,
          accepted_auth_epoch: Number(scope.auth_epoch), created_at: timestamp,
          expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        return toShareRecord(scope, binding);
      });
    } catch (error: unknown) {
      throw mapWriteError(error);
    }
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

  async stopAtomic(input: {
    scopeId: string;
    ownerId: string;
    expectedScopeRevision: number;
    expectedBindingRevision: number;
    clientRequestId: string;
    payloadHash: string;
  }): Promise<AtomicCollaborativeAppShareRecord> {
    if (!z.uuid().safeParse(input.scopeId).success || !OwnerIdSchema.safeParse(input.ownerId).success
      || !z.uuid().safeParse(input.clientRequestId).success || !DigestSchema.safeParse(input.payloadHash).success
      || !validRevision(input.expectedScopeRevision) || input.expectedScopeRevision < 1
      || !validRevision(input.expectedBindingRevision) || input.expectedBindingRevision < 1) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    try {
      return await this.db.transaction().execute(async (trx) => {
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("id", "=", input.scopeId).where("owner_id", "=", input.ownerId)
          .where("kind", "=", "app").where("deleted_at", "is", null)
          .forUpdate().executeTakeFirst();
        if (!scope) throw new CollaborativeAppShareRepositoryError("not_found");
        const operation = await trx.selectFrom("collaboration_operations").select(["payload_hash", "status"])
          .where("scope_id", "=", scope.id).where("actor_id", "=", input.ownerId)
          .where("client_request_id", "=", input.clientRequestId)
          .where("operation_kind", "=", "app.share.stop").executeTakeFirst();
        if (operation) {
          if (operation.payload_hash !== input.payloadHash || operation.status !== "completed") {
            throw new CollaborativeAppShareRepositoryError("conflict");
          }
          const replay = await trx.selectFrom("collaboration_app_bindings").selectAll()
            .where("scope_id", "=", scope.id).executeTakeFirstOrThrow();
          return toShareRecord(scope, replay);
        }
        if (Number(scope.revision) !== input.expectedScopeRevision || scope.lifecycle !== "shared") {
          throw new CollaborativeAppShareRepositoryError("conflict");
        }
        const binding = await trx.selectFrom("collaboration_app_bindings").selectAll()
          .where("scope_id", "=", scope.id).where("revision", "=", input.expectedBindingRevision)
          .where("state", "!=", "stopped").forUpdate().executeTakeFirst();
        if (!binding) throw new CollaborativeAppShareRepositoryError("conflict");
        const timestamp = this.now();
        const updatedScope = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "archived",
          revision: input.expectedScopeRevision + 1,
          auth_epoch: sql<number>`auth_epoch + 1`,
          updated_at: timestamp,
        }).where("id", "=", scope.id).where("revision", "=", input.expectedScopeRevision)
          .where("lifecycle", "=", "shared").returningAll().executeTakeFirst();
        if (!updatedScope) throw new CollaborativeAppShareRepositoryError("conflict");
        const updatedBinding = await trx.updateTable("collaboration_app_bindings").set({
          state: "stopped",
          revision: input.expectedBindingRevision + 1,
          updated_at: timestamp,
          stopped_at: timestamp,
        }).where("scope_id", "=", scope.id).where("revision", "=", input.expectedBindingRevision)
          .where("state", "!=", "stopped").returningAll().executeTakeFirst();
        if (!updatedBinding) throw new CollaborativeAppShareRepositoryError("conflict");
        const timestampIso = timestamp.toISOString();
        await appendMutationRecords(trx, {
          scope: updatedScope,
          actorId: input.ownerId,
          action: "app.share.stopped",
          recipients: [{ actorId: input.ownerId }],
          discoveryState: "revoked",
          now: timestampIso,
        });
        await trx.insertInto("collaboration_operations").values({
          scope_id: scope.id,
          actor_id: input.ownerId,
          client_request_id: input.clientRequestId,
          operation_kind: "app.share.stop",
          payload_hash: input.payloadHash,
          status: "completed",
          result_ref: jsonb({ scopeId: scope.id }),
          expected_revision: input.expectedScopeRevision,
          accepted_auth_epoch: Number(scope.auth_epoch),
          created_at: timestamp,
          expires_at: new Date(timestamp.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        return toShareRecord(updatedScope, updatedBinding);
      });
    } catch (error: unknown) {
      throw mapWriteError(error);
    }
  }

  async getByCatalog(input: { ownerId: string; catalogId: string }): Promise<AtomicCollaborativeAppShareRecord | null> {
    if (!OwnerIdSchema.safeParse(input.ownerId).success || !z.uuid().safeParse(input.catalogId).success) {
      throw new CollaborativeAppShareRepositoryError("invalid");
    }
    const row = await this.db.selectFrom("collaboration_scopes")
      .innerJoin("collaboration_app_bindings", "collaboration_app_bindings.scope_id", "collaboration_scopes.id")
      .select([
        "collaboration_scopes.id as scope_id",
        "collaboration_scopes.organization_id",
        "collaboration_scopes.revision as scope_revision",
        "collaboration_scopes.auth_epoch",
        "collaboration_scopes.created_at as scope_created_at",
        "collaboration_scopes.updated_at as scope_updated_at",
      ])
      .selectAll("collaboration_app_bindings")
      .where("collaboration_scopes.owner_id", "=", input.ownerId)
      .where("collaboration_scopes.kind", "=", "app")
      .where("collaboration_scopes.deleted_at", "is", null)
      .where("collaboration_scopes.lifecycle", "!=", "deleted")
      .where("collaboration_app_bindings.catalog_id", "=", input.catalogId)
      .executeTakeFirst();
    if (!row) return null;
    return toShareRecord({
      id: row.scope_id,
      organization_id: row.organization_id,
      revision: row.scope_revision,
      auth_epoch: row.auth_epoch,
      created_at: row.scope_created_at,
      updated_at: row.scope_updated_at,
    }, row);
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
