import { CollaborationOperationSchema, type CollaborationOperation } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import {
  appendMutationRecords,
  CollaborationRepositoryError,
  jsonb,
  MAX_SCOPE_PARTICIPANTS,
  OPERATION_RETENTION_MS,
  parseJson,
  requireAcceptedOwner,
  type ScopeRow,
} from "./repository-shared.js";

const MAX_RECOVERY_BATCH = 100;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 30_000;
const MAX_EXTERNAL_TIMEOUT_MS = 60_000;
const TransferResultSchema = z.object({
  destinationAuthorityRuntimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  destinationAuthorityGeneration: z.number().int().positive(),
  publicationMarker: z.string().regex(/^publication_[A-Za-z0-9_-]{1,128}$/),
}).strict();
const JournalSchema = z.object({
  operation: CollaborationOperationSchema,
  projectId: z.string().min(1).max(256),
  sourceOwnerId: z.string().min(1).max(128),
  sourceLifecycle: z.enum(["shared", "archived"]),
  sourceAuthorityRuntimeId: z.string().min(1).max(128),
  sourceAuthorityGeneration: z.number().int().positive(),
  fencedRevision: z.number().int().positive(),
  successorActorId: z.string().min(1).max(128).optional(),
  expectedSuccessorRevision: z.number().int().positive().optional(),
  destinationAuthorityRuntimeId: z.string().min(1).max(128).optional(),
  destinationAuthorityGeneration: z.number().int().positive().optional(),
  publicationMarker: z.string().regex(/^publication_[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict();

type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;
type Journal = z.infer<typeof JournalSchema>;

export type CollaborationProjectLifecycleInput = {
  scopeId: string;
  actorId: string;
  clientRequestId: string;
  expectedRevision: number;
  payloadHash: string;
} & (
  | { type: "archive" }
  | { type: "restore" }
  | { type: "delete" }
  | { type: "transfer"; successorActorId: string; expectedMemberRevision: number }
);

export interface ProjectTransferStager {
  (input: {
    scopeId: string;
    projectId: string;
    operationId: string;
    successorActorId: string;
    sourceAuthorityRuntimeId: string;
    sourceAuthorityGeneration: number;
    signal: AbortSignal;
  }): Promise<{
    destinationAuthorityRuntimeId: string;
    destinationAuthorityGeneration: number;
    publicationMarker: string;
  }>;
}

export interface ProjectDeletionDriver {
  (input: {
    scopeId: string;
    projectId: string;
    operationId: string;
    authorityRuntimeId: string;
    authorityGeneration: number;
    signal: AbortSignal;
  }): Promise<void>;
}

export function createCollaborationProjectLifecycle(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  stageTransfer: ProjectTransferStager;
  deleteProject: ProjectDeletionDriver;
  now?: () => Date;
  externalTimeoutMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const externalTimeoutMs = options.externalTimeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  if (!Number.isInteger(externalTimeoutMs) || externalTimeoutMs < 1
    || externalTimeoutMs > MAX_EXTERNAL_TIMEOUT_MS) {
    throw new RangeError("Invalid collaboration project lifecycle timeout");
  }

  async function apply(input: CollaborationProjectLifecycleInput): Promise<CollaborationOperation> {
    if (input.type === "archive" || input.type === "restore") {
      return applyImmediate(input);
    }
    const journal = await reserveLongRunning(input);
    if (journal.operation.status === "completed") return journal.operation;
    return resumeJournal(journal);
  }

  async function applyImmediate(
    input: CollaborationProjectLifecycleInput & { type: "archive" | "restore" },
  ): Promise<CollaborationOperation> {
    return options.db.transaction().execute(async (trx) => {
      const scope = await lockProjectScope(trx, input.scopeId);
      await requireAcceptedOwner(trx, scope.id, input.actorId);
      const replay = await readJournal(trx, input, `project.${input.type}`);
      if (replay) return replay.operation;
      if (scope.owner_id !== input.actorId || Number(scope.revision) !== input.expectedRevision) {
        throw new CollaborationRepositoryError("conflict", "Project lifecycle changed");
      }
      const expectedLifecycle = input.type === "archive" ? "shared" : "archived";
      const nextLifecycle = input.type === "archive" ? "archived" : "shared";
      if (scope.lifecycle !== expectedLifecycle) {
        throw new CollaborationRepositoryError("conflict", "Project lifecycle changed");
      }
      await assertChildrenLifecycle(trx, scope.id, expectedLifecycle);
      const committedAt = now();
      const nextRevision = Number(scope.revision) + 1;
      const updatedScope = await trx.updateTable("collaboration_scopes").set({
        lifecycle: nextLifecycle,
        revision: nextRevision,
        auth_epoch: sql<number>`auth_epoch + 1`,
        updated_at: committedAt,
      }).where("id", "=", scope.id)
        .where("revision", "=", input.expectedRevision)
        .where("lifecycle", "=", expectedLifecycle)
        .returningAll().executeTakeFirst();
      if (!updatedScope) throw new CollaborationRepositoryError("conflict", "Project lifecycle changed");
      await updateInheritedChildren(trx, scope.id, expectedLifecycle, {
        lifecycle: nextLifecycle,
        updatedAt: committedAt,
      });
      const operation = operationResult(input, nextRevision, "completed", committedAt);
      await insertCompletedOperation(trx, input, scope, `project.${input.type}`, operation, committedAt);
      await appendLifecycleRecords(trx, updatedScope, input.actorId, `scope.${input.type}d`, committedAt);
      return operation;
    });
  }

  async function reserveLongRunning(
    input: CollaborationProjectLifecycleInput & ({ type: "delete" } | { type: "transfer" }),
  ): Promise<Journal> {
    return options.db.transaction().execute(async (trx) => {
      const scope = await lockProjectScope(trx, input.scopeId);
      const operationKind = `project.${input.type}`;
      const replay = await readJournal(trx, input, operationKind);
      if (replay) return replay;
      await requireAcceptedOwner(trx, scope.id, input.actorId);
      if (scope.owner_id !== input.actorId || Number(scope.revision) !== input.expectedRevision
        || (scope.lifecycle !== "shared" && scope.lifecycle !== "archived")) {
        throw new CollaborationRepositoryError("conflict", "Project lifecycle changed");
      }
      if (input.type === "transfer") {
        const successor = await trx.selectFrom("collaboration_members").selectAll()
          .where("scope_id", "=", scope.id)
          .where("actor_id", "=", input.successorActorId)
          .forUpdate().executeTakeFirst();
        if (!successor || successor.status !== "accepted" || successor.role === "owner"
          || Number(successor.revision) !== input.expectedMemberRevision) {
          throw new CollaborationRepositoryError("conflict", "Successor membership changed");
        }
        const incompatibleBinding = await trx.selectFrom("collaboration_resource_bindings")
          .select("id").where("project_scope_id", "=", scope.id)
          .where((expression) => expression.or([
            expression("authority_runtime_id", "!=", scope.authority_runtime_id),
            expression("authority_generation", "!=", Number(scope.authority_generation)),
          ])).limit(1).executeTakeFirst();
        if (incompatibleBinding) {
          throw new CollaborationRepositoryError("conflict", "Project resource authority changed");
        }
      }
      await assertChildrenLifecycle(trx, scope.id, scope.lifecycle);
      const acceptedAt = now();
      const fencedRevision = Number(scope.revision) + 1;
      const fencedLifecycle = input.type === "delete" ? "deleting" : "recovering";
      const updatedScope = await trx.updateTable("collaboration_scopes").set({
        lifecycle: fencedLifecycle,
        revision: fencedRevision,
        auth_epoch: sql<number>`auth_epoch + 1`,
        updated_at: acceptedAt,
      }).where("id", "=", scope.id)
        .where("revision", "=", input.expectedRevision)
        .where("lifecycle", "=", scope.lifecycle)
        .returningAll().executeTakeFirst();
      if (!updatedScope) throw new CollaborationRepositoryError("conflict", "Project lifecycle changed");
      await updateInheritedChildren(trx, scope.id, scope.lifecycle, {
        lifecycle: fencedLifecycle,
        updatedAt: acceptedAt,
      });
      const operation = operationResult(input, fencedRevision, "accepted", acceptedAt);
      const journal = JournalSchema.parse({
        operation,
        projectId: scope.resource_id,
        sourceOwnerId: scope.owner_id,
        sourceLifecycle: scope.lifecycle,
        sourceAuthorityRuntimeId: scope.authority_runtime_id,
        sourceAuthorityGeneration: Number(scope.authority_generation),
        fencedRevision,
        ...(input.type === "transfer" ? {
          successorActorId: input.successorActorId,
          expectedSuccessorRevision: input.expectedMemberRevision,
        } : {}),
      });
      await trx.insertInto("collaboration_operations").values({
        scope_id: scope.id,
        actor_id: input.actorId,
        client_request_id: input.clientRequestId,
        operation_kind: operationKind,
        payload_hash: input.payloadHash,
        status: "accepted",
        result_ref: jsonb(journal),
        expected_revision: input.expectedRevision,
        accepted_auth_epoch: Number(scope.auth_epoch),
        created_at: acceptedAt,
        expires_at: new Date(acceptedAt.getTime() + OPERATION_RETENTION_MS),
      }).execute();
      await appendLifecycleRecords(
        trx,
        updatedScope,
        input.actorId,
        input.type === "delete" ? "scope.deletion_started" : "scope.transfer_started",
        acceptedAt,
      );
      return journal;
    });
  }

  async function resumeJournal(journal: Journal): Promise<CollaborationOperation> {
    try {
      if (journal.operation.type === "transfer") {
        const successorActorId = journal.successorActorId;
        if (!successorActorId || journal.expectedSuccessorRevision === undefined) {
          throw new CollaborationRepositoryError("conflict", "Transfer journal is incomplete");
        }
        const transfer = TransferResultSchema.parse(await runBounded(externalTimeoutMs, (signal) =>
          options.stageTransfer({
            scopeId: journal.operation.scopeId,
            projectId: journal.projectId,
            operationId: journal.operation.id,
            successorActorId,
            sourceAuthorityRuntimeId: journal.sourceAuthorityRuntimeId,
            sourceAuthorityGeneration: journal.sourceAuthorityGeneration,
            signal,
          })));
        if (transfer.destinationAuthorityRuntimeId === journal.sourceAuthorityRuntimeId) {
          throw new CollaborationRepositoryError("conflict", "Transfer authority did not change");
        }
        return completeTransfer(journal, transfer);
      }
      await runBounded(externalTimeoutMs, (signal) => options.deleteProject({
        scopeId: journal.operation.scopeId,
        projectId: journal.projectId,
        operationId: journal.operation.id,
        authorityRuntimeId: journal.sourceAuthorityRuntimeId,
        authorityGeneration: journal.sourceAuthorityGeneration,
        signal,
      }));
      return completeDeletion(journal);
    } catch (error: unknown) {
      if (!(error instanceof CollaborationRepositoryError)) {
        console.warn("[collaboration-project] lifecycle recovery deferred", error instanceof Error ? error.name : "UnknownError");
      }
      return journal.operation;
    }
  }

  async function completeTransfer(
    journal: Journal,
    transfer: z.infer<typeof TransferResultSchema>,
  ): Promise<CollaborationOperation> {
    return options.db.transaction().execute(async (trx) => {
      const scope = await lockProjectScope(trx, journal.operation.scopeId);
      const current = await lockJournal(trx, journal);
      if (current.operation.status === "completed") return current.operation;
      if (!journal.successorActorId || journal.expectedSuccessorRevision === undefined
        || scope.owner_id !== journal.sourceOwnerId || scope.lifecycle !== "recovering"
        || Number(scope.revision) !== journal.fencedRevision
        || scope.authority_runtime_id !== journal.sourceAuthorityRuntimeId
        || Number(scope.authority_generation) !== journal.sourceAuthorityGeneration) {
        throw new CollaborationRepositoryError("conflict", "Transfer state changed");
      }
      const members = await lockMembers(trx, scope.id);
      const owner = members.find((member) => member.actor_id === journal.sourceOwnerId);
      const successor = members.find((member) => member.actor_id === journal.successorActorId);
      if (!owner || owner.role !== "owner" || owner.status !== "accepted"
        || !successor || successor.status !== "accepted" || successor.role === "owner"
        || Number(successor.revision) !== journal.expectedSuccessorRevision
        || members.filter((member) => member.role === "owner" && member.status === "accepted").length !== 1) {
        throw new CollaborationRepositoryError("conflict", "Transfer membership changed");
      }
      const completedAt = now();
      const formerOwner = await trx.updateTable("collaboration_members").set({
        role: "editor",
        revision: Number(owner.revision) + 1,
        updated_at: completedAt,
      }).where("scope_id", "=", scope.id).where("actor_id", "=", owner.actor_id)
        .where("role", "=", "owner").where("revision", "=", Number(owner.revision))
        .returning("actor_id").executeTakeFirst();
      if (!formerOwner) throw new CollaborationRepositoryError("conflict", "Transfer membership changed");
      const nextOwner = await trx.updateTable("collaboration_members").set({
        role: "owner",
        revision: Number(successor.revision) + 1,
        updated_at: completedAt,
      }).where("scope_id", "=", scope.id).where("actor_id", "=", successor.actor_id)
        .where("role", "=", successor.role).where("revision", "=", Number(successor.revision))
        .returning("actor_id").executeTakeFirst();
      if (!nextOwner) throw new CollaborationRepositoryError("conflict", "Transfer membership changed");
      const nextRevision = journal.fencedRevision + 1;
      const updatedScope = await trx.updateTable("collaboration_scopes").set({
        owner_id: journal.successorActorId,
        lifecycle: journal.sourceLifecycle,
        revision: nextRevision,
        auth_epoch: sql<number>`auth_epoch + 1`,
        authority_runtime_id: transfer.destinationAuthorityRuntimeId,
        authority_generation: transfer.destinationAuthorityGeneration,
        updated_at: completedAt,
      }).where("id", "=", scope.id).where("owner_id", "=", journal.sourceOwnerId)
        .where("lifecycle", "=", "recovering").where("revision", "=", journal.fencedRevision)
        .returningAll().executeTakeFirst();
      if (!updatedScope) throw new CollaborationRepositoryError("conflict", "Transfer state changed");
      await updateInheritedChildren(trx, scope.id, "recovering", {
        lifecycle: journal.sourceLifecycle,
        ownerId: journal.successorActorId,
        authorityRuntimeId: transfer.destinationAuthorityRuntimeId,
        authorityGeneration: transfer.destinationAuthorityGeneration,
        updatedAt: completedAt,
      });
      await trx.updateTable("collaboration_resource_bindings").set({
        authority_runtime_id: transfer.destinationAuthorityRuntimeId,
        authority_generation: transfer.destinationAuthorityGeneration,
        updated_at: completedAt,
      }).where("project_scope_id", "=", scope.id)
        .where("authority_runtime_id", "=", journal.sourceAuthorityRuntimeId)
        .where("authority_generation", "=", journal.sourceAuthorityGeneration)
        .execute();
      const operation = completedOperation(journal, nextRevision, completedAt);
      await completeJournal(trx, journal, {
        ...journal,
        operation,
        destinationAuthorityRuntimeId: transfer.destinationAuthorityRuntimeId,
        destinationAuthorityGeneration: transfer.destinationAuthorityGeneration,
        publicationMarker: transfer.publicationMarker,
      });
      await appendLifecycleRecords(trx, updatedScope, journal.sourceOwnerId, "scope.transferred", completedAt);
      return operation;
    });
  }

  async function completeDeletion(journal: Journal): Promise<CollaborationOperation> {
    return options.db.transaction().execute(async (trx) => {
      const scope = await lockProjectScope(trx, journal.operation.scopeId);
      const current = await lockJournal(trx, journal);
      if (current.operation.status === "completed") return current.operation;
      if (scope.owner_id !== journal.sourceOwnerId || scope.lifecycle !== "deleting"
        || Number(scope.revision) !== journal.fencedRevision
        || scope.authority_runtime_id !== journal.sourceAuthorityRuntimeId
        || Number(scope.authority_generation) !== journal.sourceAuthorityGeneration) {
        throw new CollaborationRepositoryError("conflict", "Deletion state changed");
      }
      const completedAt = now();
      const nextRevision = journal.fencedRevision + 1;
      const updatedScope = await trx.updateTable("collaboration_scopes").set({
        lifecycle: "deleted",
        revision: nextRevision,
        auth_epoch: sql<number>`auth_epoch + 1`,
        deleted_at: completedAt,
        updated_at: completedAt,
      }).where("id", "=", scope.id).where("lifecycle", "=", "deleting")
        .where("revision", "=", journal.fencedRevision).returningAll().executeTakeFirst();
      if (!updatedScope) throw new CollaborationRepositoryError("conflict", "Deletion state changed");
      await updateInheritedChildren(trx, scope.id, "deleting", {
        lifecycle: "deleted",
        deletedAt: completedAt,
        updatedAt: completedAt,
      });
      const operation = completedOperation(journal, nextRevision, completedAt);
      await completeJournal(trx, journal, { ...journal, operation });
      await appendLifecycleRecords(trx, updatedScope, journal.sourceOwnerId, "scope.deleted", completedAt);
      return operation;
    });
  }

  async function recoverPending(): Promise<{ recovered: number; failed: number }> {
    const rows = await options.db.selectFrom("collaboration_operations")
      .select("result_ref")
      .where("status", "=", "accepted")
      .where("operation_kind", "in", ["project.transfer", "project.delete"])
      .orderBy("created_at", "asc")
      .limit(MAX_RECOVERY_BATCH + 1)
      .execute();
    if (rows.length > MAX_RECOVERY_BATCH) {
      throw new CollaborationRepositoryError("capacity", "Project lifecycle recovery capacity reached");
    }
    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const journal = JournalSchema.safeParse(parseJson(row.result_ref));
      if (!journal.success) {
        failed += 1;
        continue;
      }
      const result = await resumeJournal(journal.data);
      if (result.status === "completed") recovered += 1;
      else failed += 1;
    }
    return { recovered, failed };
  }

  async function getOperation(
    scopeId: string,
    actorId: string,
    operationId: string,
  ): Promise<CollaborationOperation | null> {
    const scope = await options.db.selectFrom("collaboration_scopes").select("owner_id")
      .where("id", "=", scopeId).executeTakeFirst();
    if (!scope) return null;
    let query = options.db.selectFrom("collaboration_operations")
      .select(["actor_id", "result_ref"])
      .where("scope_id", "=", scopeId)
      .where("client_request_id", "=", operationId)
      .where("operation_kind", "in", ["project.archive", "project.restore", "project.transfer", "project.delete"]);
    if (scope.owner_id !== actorId) query = query.where("actor_id", "=", actorId);
    const row = await query.executeTakeFirst();
    if (!row || (row.actor_id !== actorId && scope.owner_id !== actorId)) return null;
    const value = parseJson(row.result_ref);
    const journal = JournalSchema.safeParse(value);
    return journal.success ? journal.data.operation : CollaborationOperationSchema.parse(value);
  }

  return { apply, recoverPending, getOperation };
}

async function lockProjectScope(trx: CollaborationTransaction, scopeId: string): Promise<ScopeRow> {
  const scope = await trx.selectFrom("collaboration_scopes").selectAll()
    .where("id", "=", scopeId).forUpdate().executeTakeFirst();
  if (!scope || scope.kind !== "project" || scope.membership_mode !== "direct") {
    throw new CollaborationRepositoryError("not_found", "Shared project not found");
  }
  return scope;
}

async function readJournal(
  trx: CollaborationTransaction,
  input: { scopeId: string; actorId: string; clientRequestId: string; payloadHash: string },
  operationKind: string,
): Promise<Journal | null> {
  const row = await trx.selectFrom("collaboration_operations").select(["payload_hash", "result_ref"])
    .where("scope_id", "=", input.scopeId).where("actor_id", "=", input.actorId)
    .where("client_request_id", "=", input.clientRequestId).where("operation_kind", "=", operationKind)
    .executeTakeFirst();
  if (!row) return null;
  if (row.payload_hash !== input.payloadHash) {
    throw new CollaborationRepositoryError("conflict", "Operation key payload changed");
  }
  const value = parseJson(row.result_ref);
  const journal = JournalSchema.safeParse(value);
  if (journal.success) return journal.data;
  return {
    operation: CollaborationOperationSchema.parse(value),
    projectId: "replay",
    sourceOwnerId: input.actorId,
    sourceLifecycle: "shared",
    sourceAuthorityRuntimeId: "replay",
    sourceAuthorityGeneration: 1,
    fencedRevision: 1,
  };
}

async function lockJournal(trx: CollaborationTransaction, journal: Journal): Promise<Journal> {
  const row = await trx.selectFrom("collaboration_operations").select(["status", "result_ref"])
    .where("scope_id", "=", journal.operation.scopeId)
    .where("actor_id", "=", journal.sourceOwnerId)
    .where("client_request_id", "=", journal.operation.id)
    .where("operation_kind", "=", `project.${journal.operation.type}`)
    .forUpdate().executeTakeFirst();
  if (!row) throw new CollaborationRepositoryError("not_found", "Project lifecycle operation not found");
  if (row.status === "completed") {
    const value = parseJson(row.result_ref);
    const completed = JournalSchema.safeParse(value);
    return completed.success
      ? completed.data
      : { ...journal, operation: CollaborationOperationSchema.parse(value) };
  }
  return JournalSchema.parse(parseJson(row.result_ref));
}

async function lockMembers(trx: CollaborationTransaction, scopeId: string) {
  const rows = await trx.selectFrom("collaboration_members").selectAll()
    .where("scope_id", "=", scopeId).orderBy("actor_id", "asc")
    .limit(MAX_SCOPE_PARTICIPANTS + 1).forUpdate().execute();
  if (rows.length > MAX_SCOPE_PARTICIPANTS) {
    throw new CollaborationRepositoryError("capacity", "Project membership capacity exceeded");
  }
  return rows;
}

async function assertChildrenLifecycle(
  trx: CollaborationTransaction,
  projectScopeId: string,
  lifecycle: "shared" | "archived",
): Promise<void> {
  const incompatible = await trx.selectFrom("collaboration_scopes").select("id")
    .where("parent_scope_id", "=", projectScopeId).where("membership_mode", "=", "inherited")
    .where("deleted_at", "is", null).where("lifecycle", "!=", lifecycle)
    .limit(1).executeTakeFirst();
  if (incompatible) throw new CollaborationRepositoryError("conflict", "Project child lifecycle changed");
}

async function updateInheritedChildren(
  trx: CollaborationTransaction,
  projectScopeId: string,
  expectedLifecycle: ScopeRow["lifecycle"],
  values: {
    lifecycle: ScopeRow["lifecycle"];
    ownerId?: string;
    authorityRuntimeId?: string;
    authorityGeneration?: number;
    deletedAt?: Date;
    updatedAt: Date;
  },
): Promise<void> {
  await trx.updateTable("collaboration_scopes").set({
    lifecycle: values.lifecycle,
    revision: sql<number>`revision + 1`,
    auth_epoch: sql<number>`auth_epoch + 1`,
    ...(values.ownerId ? { owner_id: values.ownerId } : {}),
    ...(values.authorityRuntimeId ? { authority_runtime_id: values.authorityRuntimeId } : {}),
    ...(values.authorityGeneration ? { authority_generation: values.authorityGeneration } : {}),
    ...(values.deletedAt ? { deleted_at: values.deletedAt } : {}),
    updated_at: values.updatedAt,
  }).where("parent_scope_id", "=", projectScopeId)
    .where("membership_mode", "=", "inherited")
    .where("lifecycle", "=", expectedLifecycle)
    .where("deleted_at", "is", null)
    .execute();
}

async function appendLifecycleRecords(
  trx: CollaborationTransaction,
  scope: ScopeRow,
  actorId: string,
  action: string,
  at: Date,
): Promise<void> {
  const members = await trx.selectFrom("collaboration_members")
    .select(["actor_id", "invitation_id", "status"])
    .where("scope_id", "=", scope.id)
    .where("status", "in", ["accepted", "pending"])
    .orderBy("actor_id", "asc").limit(MAX_SCOPE_PARTICIPANTS + 1).execute();
  if (members.length > MAX_SCOPE_PARTICIPANTS) {
    throw new CollaborationRepositoryError("capacity", "Project membership capacity exceeded");
  }
  await appendMutationRecords(trx, {
    scope,
    actorId,
    action,
    recipients: members.map((member) => ({
      actorId: member.actor_id,
      ...(member.invitation_id ? { invitationId: member.invitation_id } : {}),
    })),
    discoveryState: scope.lifecycle === "deleted" ? "deleted" : "accepted",
    now: at.toISOString(),
  });
}

async function insertCompletedOperation(
  trx: CollaborationTransaction,
  input: CollaborationProjectLifecycleInput,
  scope: ScopeRow,
  operationKind: string,
  operation: CollaborationOperation,
  at: Date,
): Promise<void> {
  await trx.insertInto("collaboration_operations").values({
    scope_id: scope.id,
    actor_id: input.actorId,
    client_request_id: input.clientRequestId,
    operation_kind: operationKind,
    payload_hash: input.payloadHash,
    status: "completed",
    result_ref: jsonb(operation),
    expected_revision: input.expectedRevision,
    accepted_auth_epoch: Number(scope.auth_epoch),
    created_at: at,
    expires_at: new Date(at.getTime() + OPERATION_RETENTION_MS),
  }).execute();
}

async function completeJournal(
  trx: CollaborationTransaction,
  journal: Journal,
  completed: Journal,
): Promise<void> {
  const updated = await trx.updateTable("collaboration_operations").set({
    status: "completed",
    result_ref: jsonb(completed),
  }).where("scope_id", "=", journal.operation.scopeId)
    .where("actor_id", "=", journal.sourceOwnerId)
    .where("client_request_id", "=", journal.operation.id)
    .where("operation_kind", "=", `project.${journal.operation.type}`)
    .where("status", "=", "accepted")
    .returning("client_request_id").executeTakeFirst();
  if (!updated) throw new CollaborationRepositoryError("conflict", "Project lifecycle operation changed");
}

function operationResult(
  input: CollaborationProjectLifecycleInput,
  revision: number,
  status: "accepted" | "completed",
  at: Date,
): CollaborationOperation {
  return CollaborationOperationSchema.parse({
    id: input.clientRequestId,
    scopeId: input.scopeId,
    type: input.type,
    status,
    revision: String(revision),
    createdAt: at.toISOString(),
  });
}

function completedOperation(journal: Journal, revision: number, at: Date): CollaborationOperation {
  return CollaborationOperationSchema.parse({
    ...journal.operation,
    status: "completed",
    revision: String(revision),
    createdAt: at.toISOString(),
  });
}

async function runBounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(new CollaborationRepositoryError("conflict", "Project lifecycle operation timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation(signal).then((value) => finish(undefined, value), (error) => finish(error));
  });
}
