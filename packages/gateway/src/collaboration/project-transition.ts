import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import type {
  CollaborationTransitionsTable,
  OwnerCollaborationDatabase,
} from "./database.js";
import {
  ProjectMembershipTransitionError,
  reconcileProjectMembershipAtPublication,
} from "./project-membership-transition.js";
import { jsonb, OPERATION_RETENTION_MS, parseJson } from "./repository-shared.js";

const MAX_RECOVERY_BATCH = 100;
const DEFAULT_RECOVERY_TIMEOUT_MS = 30_000;
const MAX_RECOVERY_TIMEOUT_MS = 60_000;
const TransitionIdSchema = z.uuid();
const ScopeIdSchema = z.uuid();
const ActorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ClientRequestIdSchema = z.uuid();
const PreparationResultSchema = z.object({ transitionId: TransitionIdSchema }).strict();
const ManifestRefSchema = z.string().regex(/^manifest_[A-Za-z0-9_-]{1,128}$/);
const PublicationMarkerSchema = z.string().regex(/^publication_[A-Za-z0-9_-]{1,128}$/);
const PositiveGenerationSchema = z.number().int().positive();
const NonnegativeRevisionSchema = z.number().int().nonnegative();

export type ProjectTransitionStatus =
  | "prepared"
  | "staging"
  | "fenced"
  | "committing"
  | "active"
  | "failed"
  | "recovering";

export interface ProjectTransitionRecord {
  id: string;
  scopeId: string;
  sourceAuthorityRuntimeId: string;
  sourceAuthorityGeneration: number;
  destinationAuthorityRuntimeId: string;
  destinationAuthorityGeneration: number;
  requestedBy: string;
  inventoryRevision: number;
  inventoryHash: string;
  membershipHash: string;
  status: ProjectTransitionStatus;
  sourceFenceEpoch?: number;
  stagedManifestRef?: string;
  publicationMarker?: string;
  retryCount: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectTransitionError extends Error {
  constructor(public readonly code: "not_found" | "conflict" | "capacity" | "unavailable") {
    super("Project sharing transition is unavailable");
    this.name = "ProjectTransitionError";
  }
}

type TransitionRow = Selectable<CollaborationTransitionsTable>;
type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToTransition(row: TransitionRow): ProjectTransitionRecord {
  return {
    id: row.id,
    scopeId: row.scope_id,
    sourceAuthorityRuntimeId: row.source_authority_runtime_id,
    sourceAuthorityGeneration: Number(row.source_authority_generation),
    destinationAuthorityRuntimeId: row.destination_authority_runtime_id,
    destinationAuthorityGeneration: Number(row.destination_authority_generation),
    requestedBy: row.requested_by,
    inventoryRevision: Number(row.inventory_revision),
    inventoryHash: row.inventory_hash,
    membershipHash: row.intended_membership_hash,
    status: row.status,
    ...(row.source_fence_epoch === null ? {} : { sourceFenceEpoch: Number(row.source_fence_epoch) }),
    ...(row.staged_manifest_ref === null ? {} : { stagedManifestRef: row.staged_manifest_ref }),
    ...(row.publication_marker === null ? {} : { publicationMarker: row.publication_marker }),
    retryCount: row.retry_count,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function waitForRecoveryAttempt<T>(
  signal: AbortSignal,
  attempt: Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new ProjectTransitionError("unavailable");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(new ProjectTransitionError("unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    void attempt.then((value) => finish(undefined, value), (error: unknown) => finish(error));
  });
}

async function lockTransition<T>(
  db: Kysely<OwnerCollaborationDatabase>,
  transitionId: string,
  operation: (
    trx: CollaborationTransaction,
    row: TransitionRow,
    scope: Selectable<OwnerCollaborationDatabase["collaboration_scopes"]>,
  ) => Promise<T>,
): Promise<T> {
  const id = TransitionIdSchema.parse(transitionId);
  const hint = await db.selectFrom("collaboration_transitions")
    .select("scope_id").where("id", "=", id).executeTakeFirst();
  if (!hint) throw new ProjectTransitionError("not_found");
  return db.transaction().execute(async (trx) => {
    const scope = await trx.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", hint.scope_id).forUpdate().executeTakeFirst();
    if (!scope) throw new ProjectTransitionError("not_found");
    const row = await trx.selectFrom("collaboration_transitions").selectAll()
      .where("id", "=", id).where("scope_id", "=", scope.id).forUpdate().executeTakeFirst();
    if (!row) throw new ProjectTransitionError("not_found");
    return operation(trx, row, scope);
  });
}

async function updateStatus(
  trx: CollaborationTransaction,
  row: TransitionRow,
  expected: ProjectTransitionStatus,
  next: ProjectTransitionStatus,
  now: Date,
  values: Partial<{
    source_fence_epoch: number;
    staged_manifest_ref: string;
    publication_marker: string;
    error_code: string;
  }> = {},
): Promise<ProjectTransitionRecord> {
  if (row.status !== expected) throw new ProjectTransitionError("conflict");
  const updated = await trx.updateTable("collaboration_transitions").set({
    status: next,
    updated_at: now,
    ...values,
  }).where("id", "=", row.id).where("status", "=", expected)
    .returningAll().executeTakeFirst();
  if (!updated) throw new ProjectTransitionError("conflict");
  return rowToTransition(updated);
}

export function createProjectTransitionJournal(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  now?: () => Date;
  createTransitionId?: () => string;
  createEventId?: () => string;
  recoveryTimeoutMs?: number;
  recoveryBatchSize?: number;
}) {
  const now = options.now ?? (() => new Date());
  const createTransitionId = options.createTransitionId ?? randomUUID;
  const createEventId = options.createEventId ?? randomUUID;
  const recoveryTimeoutMs = options.recoveryTimeoutMs === undefined
    ? DEFAULT_RECOVERY_TIMEOUT_MS
    : Math.trunc(options.recoveryTimeoutMs);
  if (!Number.isFinite(recoveryTimeoutMs) || recoveryTimeoutMs < 1
    || recoveryTimeoutMs > MAX_RECOVERY_TIMEOUT_MS) {
    throw new RangeError("Invalid project transition recovery timeout");
  }
  const recoveryBatchSize = options.recoveryBatchSize === undefined
    ? MAX_RECOVERY_BATCH
    : Math.trunc(options.recoveryBatchSize);
  if (!Number.isFinite(recoveryBatchSize) || recoveryBatchSize < 1
    || recoveryBatchSize > MAX_RECOVERY_BATCH) {
    throw new RangeError("Invalid project transition recovery batch size");
  }
  const activeRecoveryAttempts = new Map<string, Promise<"activated" | "failed" | null>>();

  async function get(transitionId: string): Promise<ProjectTransitionRecord | null> {
    const id = TransitionIdSchema.parse(transitionId);
    const row = await options.db.selectFrom("collaboration_transitions").selectAll()
      .where("id", "=", id).executeTakeFirst();
    return row ? rowToTransition(row) : null;
  }

  async function prepare(input: {
    scopeId: string;
    ownerId: string;
    requestedBy: string;
    clientRequestId: string;
    payloadHash: string;
    expectedScopeRevision: number;
    inventoryRevision: number;
    inventoryHash: string;
    membershipHash: string;
    destinationAuthorityRuntimeId: string;
    destinationAuthorityGeneration: number;
  }): Promise<ProjectTransitionRecord> {
    const parsed = z.object({
      scopeId: ScopeIdSchema,
      ownerId: ActorIdSchema,
      requestedBy: ActorIdSchema,
      clientRequestId: ClientRequestIdSchema,
      payloadHash: DigestSchema,
      expectedScopeRevision: NonnegativeRevisionSchema,
      inventoryRevision: NonnegativeRevisionSchema,
      inventoryHash: DigestSchema,
      membershipHash: DigestSchema,
      destinationAuthorityRuntimeId: RuntimeIdSchema,
      destinationAuthorityGeneration: PositiveGenerationSchema,
    }).strict().parse(input);
    if (parsed.requestedBy !== parsed.ownerId) throw new ProjectTransitionError("conflict");
    const transitionId = TransitionIdSchema.parse(createTransitionId());
    const createdAt = now();
    try {
      return await options.db.transaction().execute(async (trx) => {
        const scope = await trx.selectFrom("collaboration_scopes").selectAll()
          .where("id", "=", parsed.scopeId).forUpdate().executeTakeFirst();
        if (!scope || scope.kind !== "project" || scope.owner_id !== parsed.ownerId) {
          throw new ProjectTransitionError("conflict");
        }
        const replay = await trx.selectFrom("collaboration_operations")
          .select(["payload_hash", "status", "result_ref"])
          .where("scope_id", "=", scope.id)
          .where("actor_id", "=", parsed.requestedBy)
          .where("client_request_id", "=", parsed.clientRequestId)
          .where("operation_kind", "=", "project.confirm")
          .executeTakeFirst();
        if (replay) {
          if (replay.payload_hash !== parsed.payloadHash || replay.status !== "completed") {
            throw new ProjectTransitionError("conflict");
          }
          const result = PreparationResultSchema.safeParse(parseJson(replay.result_ref));
          if (!result.success) throw new ProjectTransitionError("unavailable");
          const existing = await trx.selectFrom("collaboration_transitions").selectAll()
            .where("id", "=", result.data.transitionId)
            .where("scope_id", "=", scope.id)
            .executeTakeFirst();
          if (!existing) throw new ProjectTransitionError("unavailable");
          return rowToTransition(existing);
        }
        const sameRuntime = scope.authority_runtime_id === parsed.destinationAuthorityRuntimeId;
        if (scope.membership_mode !== "direct"
          || scope.lifecycle !== "private" || Number(scope.revision) !== parsed.expectedScopeRevision
          || (sameRuntime
            && parsed.destinationAuthorityGeneration !== Number(scope.authority_generation) + 1)) {
          throw new ProjectTransitionError("conflict");
        }
        const updatedScope = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "preparing",
          updated_at: createdAt,
        }).where("id", "=", scope.id)
          .where("lifecycle", "=", "private")
          .where("revision", "=", parsed.expectedScopeRevision)
          .where("authority_runtime_id", "=", scope.authority_runtime_id)
          .where("authority_generation", "=", Number(scope.authority_generation))
          .returning("id").executeTakeFirst();
        if (!updatedScope) throw new ProjectTransitionError("conflict");
        const row = await trx.insertInto("collaboration_transitions").values({
          id: transitionId,
          scope_id: scope.id,
          source_authority_runtime_id: scope.authority_runtime_id,
          source_authority_generation: Number(scope.authority_generation),
          destination_authority_runtime_id: parsed.destinationAuthorityRuntimeId,
          destination_authority_generation: parsed.destinationAuthorityGeneration,
          requested_by: parsed.requestedBy,
          inventory_revision: parsed.inventoryRevision,
          inventory_hash: parsed.inventoryHash,
          intended_membership_hash: parsed.membershipHash,
          status: "prepared",
          source_fence_epoch: null,
          staged_manifest_ref: null,
          publication_marker: null,
          retry_count: 0,
          error_code: null,
          created_at: createdAt,
          updated_at: createdAt,
        }).returningAll().executeTakeFirstOrThrow();
        await trx.insertInto("collaboration_operations").values({
          scope_id: scope.id,
          actor_id: parsed.requestedBy,
          client_request_id: parsed.clientRequestId,
          operation_kind: "project.confirm",
          payload_hash: parsed.payloadHash,
          status: "completed",
          result_ref: jsonb({ transitionId: row.id }),
          expected_revision: parsed.expectedScopeRevision,
          accepted_auth_epoch: Number(scope.auth_epoch),
          created_at: createdAt,
          expires_at: new Date(createdAt.getTime() + OPERATION_RETENTION_MS),
        }).execute();
        return rowToTransition(row);
      });
    } catch (error: unknown) {
      if (error instanceof ProjectTransitionError) throw error;
      if (isUniqueViolation(error)) throw new ProjectTransitionError("conflict");
      console.warn("[collaboration-project] transition preparation failed", error instanceof Error ? error.name : "UnknownError");
      throw new ProjectTransitionError("unavailable");
    }
  }

  async function beginStaging(transitionId: string): Promise<ProjectTransitionRecord> {
    return lockTransition(options.db, transitionId, async (trx, row) =>
      updateStatus(trx, row, "prepared", "staging", now()));
  }

  async function recordStagedManifest(
    transitionId: string,
    stagedManifestRef: string,
  ): Promise<ProjectTransitionRecord> {
    const manifest = ManifestRefSchema.parse(stagedManifestRef);
    return lockTransition(options.db, transitionId, async (trx, row) => {
      if (row.status !== "staging") throw new ProjectTransitionError("conflict");
      if (row.staged_manifest_ref === manifest) return rowToTransition(row);
      if (row.staged_manifest_ref !== null) throw new ProjectTransitionError("conflict");
      const updated = await trx.updateTable("collaboration_transitions").set({
        staged_manifest_ref: manifest,
        updated_at: now(),
      }).where("id", "=", row.id).where("status", "=", "staging")
        .where("staged_manifest_ref", "is", null).returningAll().executeTakeFirst();
      if (!updated) throw new ProjectTransitionError("conflict");
      return rowToTransition(updated);
    });
  }

  async function markFenced(input: {
    transitionId: string;
    sourceFenceEpoch: number;
    currentInventoryRevision: number;
    currentInventoryHash: string;
    currentMembershipHash: string;
  }): Promise<boolean> {
    const parsed = z.object({
      transitionId: TransitionIdSchema,
      sourceFenceEpoch: PositiveGenerationSchema,
      currentInventoryRevision: NonnegativeRevisionSchema,
      currentInventoryHash: DigestSchema,
      currentMembershipHash: DigestSchema,
    }).strict().parse(input);
    return lockTransition(options.db, parsed.transitionId, async (trx, row, scope) => {
      if (row.status !== "staging" || row.staged_manifest_ref === null) {
        throw new ProjectTransitionError("conflict");
      }
      const matches = Number(row.inventory_revision) === parsed.currentInventoryRevision
        && row.inventory_hash === parsed.currentInventoryHash
        && row.intended_membership_hash === parsed.currentMembershipHash;
      if (!matches) {
        const failed = await trx.updateTable("collaboration_transitions").set({
          status: "recovering",
          source_fence_epoch: parsed.sourceFenceEpoch,
          error_code: "inventory_changed",
          updated_at: now(),
        }).where("id", "=", row.id).where("status", "=", "staging")
          .returning("id").executeTakeFirst();
        const restored = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "recovering",
          updated_at: now(),
        }).where("id", "=", scope.id).where("lifecycle", "=", "preparing")
          .where("authority_runtime_id", "=", row.source_authority_runtime_id)
          .where("authority_generation", "=", Number(row.source_authority_generation))
          .returning("id").executeTakeFirst();
        if (!failed || !restored) throw new ProjectTransitionError("conflict");
        return false;
      }
      await updateStatus(trx, row, "staging", "fenced", now(), {
        source_fence_epoch: parsed.sourceFenceEpoch,
      });
      return true;
    });
  }

  async function beginCommit(transitionId: string): Promise<ProjectTransitionRecord> {
    return lockTransition(options.db, transitionId, async (trx, row) => {
      if (row.source_fence_epoch === null || row.staged_manifest_ref === null) {
        throw new ProjectTransitionError("conflict");
      }
      return updateStatus(trx, row, "fenced", "committing", now());
    });
  }

  async function recordPublication(
    transitionId: string,
    publicationMarker: string,
  ): Promise<ProjectTransitionRecord> {
    const marker = PublicationMarkerSchema.parse(publicationMarker);
    return lockTransition(options.db, transitionId, async (trx, row) => {
      if (row.status !== "committing") throw new ProjectTransitionError("conflict");
      if (row.publication_marker === marker) return rowToTransition(row);
      if (row.publication_marker !== null) throw new ProjectTransitionError("conflict");
      const updated = await trx.updateTable("collaboration_transitions").set({
        publication_marker: marker,
        updated_at: now(),
      }).where("id", "=", row.id).where("status", "=", "committing")
        .where("publication_marker", "is", null).returningAll().executeTakeFirst();
      if (!updated) throw new ProjectTransitionError("conflict");
      return rowToTransition(updated);
    });
  }

  async function activate(transitionId: string): Promise<ProjectTransitionRecord> {
    try {
      return await lockTransition(options.db, transitionId, async (trx, row, scope) => {
        if (row.status === "active") return rowToTransition(row);
        if (!(["committing", "recovering"] as ProjectTransitionStatus[]).includes(row.status)
          || row.publication_marker === null || row.source_fence_epoch === null
          || (scope.lifecycle !== "preparing" && scope.lifecycle !== "recovering")) {
          throw new ProjectTransitionError("conflict");
        }
        const incompatibleBinding = await trx.selectFrom("collaboration_resource_bindings")
          .select("id").where("project_scope_id", "=", scope.id)
          .where((expression) => expression.or([
            expression("readiness", "=", "blocked"),
            expression("authority_runtime_id", "!=", row.destination_authority_runtime_id),
            expression("authority_generation", "!=", Number(row.destination_authority_generation)),
          ])).limit(1).executeTakeFirst();
        if (incompatibleBinding) throw new ProjectTransitionError("conflict");
        try {
          await reconcileProjectMembershipAtPublication(trx, {
            projectScopeId: scope.id,
            ownerType: scope.owner_type,
            ownerId: scope.owner_id,
            requestedBy: row.requested_by,
            destinationAuthorityRuntimeId: row.destination_authority_runtime_id,
            destinationAuthorityGeneration: Number(row.destination_authority_generation),
            now: now(),
            createEventId,
          });
        } catch (error: unknown) {
          if (error instanceof ProjectMembershipTransitionError) {
            throw new ProjectTransitionError(error.code);
          }
          throw error;
        }
        const nextRevision = Number(scope.revision) + 1;
        const updatedScope = await trx.updateTable("collaboration_scopes").set({
          lifecycle: "shared",
          revision: nextRevision,
          auth_epoch: Number(scope.auth_epoch) + 1,
          authority_runtime_id: row.destination_authority_runtime_id,
          authority_generation: Number(row.destination_authority_generation),
          updated_at: now(),
        }).where("id", "=", scope.id)
          .where("lifecycle", "in", ["preparing", "recovering"])
          .where("revision", "=", Number(scope.revision))
          .where("authority_runtime_id", "=", row.source_authority_runtime_id)
          .where("authority_generation", "=", Number(row.source_authority_generation))
          .returningAll().executeTakeFirst();
        if (!updatedScope) throw new ProjectTransitionError("conflict");
        const updated = await trx.updateTable("collaboration_transitions").set({
          status: "active",
          error_code: null,
          updated_at: now(),
        }).where("id", "=", row.id).where("status", "=", row.status)
          .returningAll().executeTakeFirst();
        if (!updated) throw new ProjectTransitionError("conflict");
        const latestEvent = await trx.selectFrom("collaboration_events")
          .select("scope_seq").where("scope_id", "=", scope.id)
          .orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
        const scopeSequence = Number(latestEvent?.scope_seq ?? 0) + 1;
        const eventId = z.uuid().parse(createEventId());
        await trx.insertInto("collaboration_events").values({
          scope_id: scope.id,
          scope_seq: scopeSequence,
          event_id: eventId,
          resource_kind: "project",
          resource_id: scope.resource_id,
          revision: nextRevision,
          authority_generation: Number(updatedScope.authority_generation),
          event_type: "project.transition.active",
          payload: {},
          created_at: now(),
        }).execute();
        const acceptedMembers = await trx.selectFrom("collaboration_members")
          .select("actor_id")
          .where("scope_id", "=", scope.id)
          .where("status", "=", "accepted")
          .orderBy("actor_id", "asc")
          .execute();
        acceptedMembers.sort((left, right) => {
          if (left.actor_id === scope.owner_id) return -1;
          if (right.actor_id === scope.owner_id) return 1;
          return left.actor_id.localeCompare(right.actor_id);
        });
        if (acceptedMembers.length > 0) {
          await trx.insertInto("collaboration_directory_outbox").values({
            event_id: eventId,
            scope_id: scope.id,
            recipient_actor_ids: jsonb(acceptedMembers.map((member) => ({ actorId: member.actor_id }))),
            authority_runtime_id: row.destination_authority_runtime_id,
            authority_generation: Number(row.destination_authority_generation),
            resource_kind: "project",
            discovery_state: "accepted",
            retry_after: now(),
            attempts: 0,
            delivered_at: null,
            created_at: now(),
          }).execute();
        }
        const pendingMembers = await trx.selectFrom("collaboration_members")
          .select(["actor_id", "invitation_id"])
          .where("scope_id", "=", scope.id)
          .where("status", "=", "pending")
          .where("invitation_id", "is not", null)
          .orderBy("actor_id", "asc")
          .execute();
        if (pendingMembers.length > 0) {
          const invitedEventId = z.uuid().parse(createEventId());
          await trx.insertInto("collaboration_events").values({
            scope_id: scope.id,
            scope_seq: scopeSequence + 1,
            event_id: invitedEventId,
            resource_kind: "project",
            resource_id: scope.resource_id,
            revision: nextRevision,
            authority_generation: Number(updatedScope.authority_generation),
            event_type: "project.transition.invited",
            payload: {},
            created_at: now(),
          }).execute();
          await trx.insertInto("collaboration_directory_outbox").values({
            event_id: invitedEventId,
            scope_id: scope.id,
            recipient_actor_ids: jsonb(pendingMembers.map((member) => ({
              actorId: member.actor_id,
              invitationId: member.invitation_id!,
            }))),
            authority_runtime_id: row.destination_authority_runtime_id,
            authority_generation: Number(row.destination_authority_generation),
            resource_kind: "project",
            discovery_state: "invited",
            retry_after: now(),
            attempts: 0,
            delivered_at: null,
            created_at: now(),
          }).execute();
        }
        await trx.insertInto("collaboration_audit").values({
          scope_id: scope.id,
          actor_id: row.requested_by,
          action: "project.transition.active",
          outcome: "completed",
          revision: nextRevision,
          reason_code: null,
          created_at: now(),
        }).execute();
        return rowToTransition(updated);
      });
    } catch (error: unknown) {
      if (error instanceof ProjectTransitionError && error.code === "conflict") {
        const current = await get(transitionId);
        if (current?.status === "active") return current;
      }
      throw error;
    }
  }

  async function enterRecovery(row: ProjectTransitionRecord): Promise<ProjectTransitionRecord> {
    return lockTransition(options.db, row.id, async (trx, current, scope) => {
      if (current.status === "active" || current.status === "failed") return rowToTransition(current);
      const updated = await trx.updateTable("collaboration_transitions").set({
        status: "recovering",
        retry_count: sql<number>`retry_count + 1`,
        updated_at: now(),
      }).where("id", "=", current.id).where("status", "=", current.status)
        .where("retry_count", "<", 20).returningAll().executeTakeFirst();
      if (!updated) throw new ProjectTransitionError("capacity");
      if (scope.lifecycle === "preparing") {
        await trx.updateTable("collaboration_scopes").set({ lifecycle: "recovering", updated_at: now() })
          .where("id", "=", scope.id).where("lifecycle", "=", "preparing").execute();
      }
      return rowToTransition(updated);
    });
  }

  async function failRecovered(transitionId: string): Promise<ProjectTransitionRecord> {
    return lockTransition(options.db, transitionId, async (trx, row, scope) => {
      if (row.status !== "recovering" || row.publication_marker !== null) {
        throw new ProjectTransitionError("conflict");
      }
      const restored = await trx.updateTable("collaboration_scopes").set({
        lifecycle: "private",
        updated_at: now(),
      }).where("id", "=", scope.id).where("lifecycle", "in", ["preparing", "recovering"])
        .where("authority_runtime_id", "=", row.source_authority_runtime_id)
        .where("authority_generation", "=", Number(row.source_authority_generation))
        .returning("id").executeTakeFirst();
      if (!restored) throw new ProjectTransitionError("conflict");
      return updateStatus(trx, row, "recovering", "failed", now(), {
        error_code: row.error_code ?? "recovered_before_publication",
      });
    });
  }

  async function recover(input: {
    cleanupStaging(value: {
      transitionId: string;
      stagedManifestRef?: string;
      sourceFenceEpoch?: number;
      signal: AbortSignal;
    }): Promise<void>;
    completePublication(value: {
      transitionId: string;
      publicationMarker: string;
      stagedManifestRef: string;
      signal: AbortSignal;
    }): Promise<void>;
  }): Promise<{ recovered: number; activated: number; failed: number }> {
    const rows = await options.db.selectFrom("collaboration_transitions").selectAll()
      .where("status", "in", ["prepared", "staging", "fenced", "committing", "recovering"])
      .orderBy("created_at", "asc").limit(recoveryBatchSize).execute();
    let recovered = 0;
    let activated = 0;
    let failed = 0;
    for (const value of rows.map(rowToTransition)) {
      if (activeRecoveryAttempts.has(value.id)) continue;
      if (activeRecoveryAttempts.size >= MAX_RECOVERY_BATCH) break;
      const signal = AbortSignal.timeout(recoveryTimeoutMs);
      let attempt: Promise<"activated" | "failed" | null>;
      attempt = (async () => {
        const current = await enterRecovery(value);
        if (current.publicationMarker) {
          if (!current.stagedManifestRef) throw new ProjectTransitionError("conflict");
          await input.completePublication({
            transitionId: current.id,
            publicationMarker: current.publicationMarker,
            stagedManifestRef: current.stagedManifestRef,
            signal,
          });
          await activate(current.id);
          return "activated" as const;
        }
        await input.cleanupStaging({
          transitionId: current.id,
          ...(current.stagedManifestRef ? { stagedManifestRef: current.stagedManifestRef } : {}),
          ...(current.sourceFenceEpoch ? { sourceFenceEpoch: current.sourceFenceEpoch } : {}),
          signal,
        });
        await failRecovered(current.id);
        return "failed" as const;
      })().catch((error: unknown) => {
        console.warn(
          "[collaboration-project] transition recovery deferred",
          error instanceof Error ? error.name : "UnknownError",
        );
        return null;
      }).finally(() => {
        if (activeRecoveryAttempts.get(value.id) === attempt) activeRecoveryAttempts.delete(value.id);
      });
      activeRecoveryAttempts.set(value.id, attempt);
      try {
        const outcome = await waitForRecoveryAttempt(signal, attempt);
        if (outcome === "activated") {
          activated += 1;
          recovered += 1;
        } else if (outcome === "failed") {
          failed += 1;
          recovered += 1;
        }
      } catch (error: unknown) {
        console.warn("[collaboration-project] transition recovery deferred", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return { recovered, activated, failed };
  }

  return {
    get,
    prepare,
    beginStaging,
    recordStagedManifest,
    markFenced,
    beginCommit,
    recordPublication,
    activate,
    recover,
  };
}
