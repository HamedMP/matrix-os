import { randomUUID } from "node:crypto";
import { sql, type Selectable, type Transaction } from "kysely";
import type { CollaborationScopesTable, OwnerCollaborationDatabase } from "./database.js";

export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_SCOPE_PARTICIPANTS = 8;

export type ScopeRow = Selectable<CollaborationScopesTable>;

export type CollaborationRepositoryErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "capacity"
  | "expired";

export class CollaborationRepositoryError extends Error {
  constructor(
    public readonly code: CollaborationRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationRepositoryError";
  }
}

export async function lockDirectScope(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
): Promise<ScopeRow> {
  const scope = await trx.selectFrom("collaboration_scopes")
    .selectAll()
    .where("id", "=", scopeId)
    .where("deleted_at", "is", null)
    .where("lifecycle", "!=", "deleted")
    .forUpdate()
    .executeTakeFirst();
  if (!scope) throw new CollaborationRepositoryError("not_found", "Scope not found");
  if (scope.membership_mode !== "direct") {
    throw new CollaborationRepositoryError("conflict", "Scope membership is inherited");
  }
  return scope;
}

export async function requireAcceptedOwner(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  actorId: string,
): Promise<void> {
  const member = await trx.selectFrom("collaboration_members")
    .select(["role", "status"])
    .where("scope_id", "=", scopeId)
    .where("actor_id", "=", actorId)
    .executeTakeFirst();
  if (!member || member.role !== "owner" || member.status !== "accepted") {
    throw new CollaborationRepositoryError("forbidden", "Owner access required");
  }
}

export async function updateScopeRevision(
  trx: Transaction<OwnerCollaborationDatabase>,
  scopeId: string,
  expectedRevision: number,
  nextRevision: number,
  now: string,
): Promise<void> {
  const updated = await trx.updateTable("collaboration_scopes").set({
    revision: nextRevision,
    auth_epoch: sql<number>`auth_epoch + 1`,
    updated_at: now,
  }).where("id", "=", scopeId)
    .where("revision", "=", expectedRevision)
    .returning("revision")
    .executeTakeFirst();
  if (!updated) {
    throw new CollaborationRepositoryError("conflict", "Scope revision changed");
  }
}

export async function readOperationReplay<T>(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: { scopeId: string; actorId: string; clientRequestId: string; payloadHash: string },
  operationKind: string,
): Promise<T | null> {
  const row = await trx.selectFrom("collaboration_operations")
    .select(["payload_hash", "status", "result_ref"])
    .where("scope_id", "=", input.scopeId)
    .where("actor_id", "=", input.actorId)
    .where("client_request_id", "=", input.clientRequestId)
    .where("operation_kind", "=", operationKind)
    .executeTakeFirst();
  if (!row) return null;
  if (row.payload_hash !== input.payloadHash) {
    throw new CollaborationRepositoryError("conflict", "Operation key payload changed");
  }
  if (row.status !== "completed" || row.result_ref === null) {
    throw new CollaborationRepositoryError("conflict", "Operation has not completed");
  }
  return parseJson<T>(row.result_ref);
}

export async function writeOperation(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: {
    scopeId: string;
    actorId: string;
    clientRequestId: string;
    payloadHash: string;
    expectedRevision: number;
  },
  operationKind: string,
  scope: ScopeRow,
  result: unknown,
  now: string,
  expiresAt: string,
): Promise<void> {
  await trx.insertInto("collaboration_operations").values({
    scope_id: input.scopeId,
    actor_id: input.actorId,
    client_request_id: input.clientRequestId,
    operation_kind: operationKind,
    payload_hash: input.payloadHash,
    status: "completed",
    result_ref: jsonb(result),
    expected_revision: input.expectedRevision,
    accepted_auth_epoch: Number(scope.auth_epoch),
    created_at: now,
    expires_at: expiresAt,
  }).execute();
}

export async function appendMutationRecords(
  trx: Transaction<OwnerCollaborationDatabase>,
  input: {
    scope: ScopeRow;
    actorId: string;
    action: string;
    recipients: Array<{ actorId: string; invitationId?: string }>;
    discoveryState: "invited" | "accepted" | "revoked" | "deleted";
    now: string;
    reasonCode?: string;
  },
): Promise<void> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max("scope_seq").as("sequence"))
    .where("scope_id", "=", input.scope.id)
    .executeTakeFirst();
  const sequence = Number(latest?.sequence ?? 0) + 1;
  const eventId = randomUUID();
  await trx.insertInto("collaboration_events").values({
    scope_id: input.scope.id,
    scope_seq: sequence,
    event_id: eventId,
    resource_kind: input.scope.kind,
    resource_id: input.scope.resource_id,
    revision: Number(input.scope.revision),
    authority_generation: Number(input.scope.authority_generation),
    event_type: input.action,
    payload: jsonb({}),
    created_at: input.now,
  }).execute();
  await trx.insertInto("collaboration_audit").values({
    scope_id: input.scope.id,
    actor_id: input.actorId,
    action: input.action,
    outcome: "completed",
    revision: Number(input.scope.revision),
    reason_code: input.reasonCode ?? null,
    created_at: input.now,
  }).execute();
  await trx.insertInto("collaboration_directory_outbox").values({
    event_id: eventId,
    scope_id: input.scope.id,
    recipient_actor_ids: jsonb(input.recipients),
    authority_runtime_id: input.scope.authority_runtime_id,
    authority_generation: Number(input.scope.authority_generation),
    resource_kind: input.scope.kind,
    discovery_state: input.discoveryState,
    retry_after: input.now,
    delivered_at: null,
    created_at: input.now,
  }).execute();
}

export function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

export function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
