import { z } from "zod/v4";
import { sql, type Transaction } from "kysely";
import {
  SpeechExecutionStateSchema,
  SpeechOutcomeCodeSchema,
  SpeechRequestIdSchema,
  SpeechSourceKindSchema,
  type SpeechExecutionState,
  type SpeechOutcomeCode,
  type SpeechSourceKind,
} from "@matrix-os/contracts";
import type { PlatformDB, PlatformDatabase, SpeechOperationsTable } from "../db.js";

const ReferenceSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const RuntimeSlotSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);
const HashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.object({
  ownerId: ReferenceSchema,
  machineId: ReferenceSchema,
  runtimeSlot: RuntimeSlotSchema,
}).strict();
const AdmissionSchema = z.object({
  identity: IdentitySchema,
  requestId: SpeechRequestIdSchema,
  sourceKind: SpeechSourceKindSchema,
  contentFingerprint: HashSchema,
  policyRevision: ReferenceSchema,
  adapterId: ReferenceSchema,
  modelId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  audioDurationMs: z.number().int().positive().max(60 * 60_000),
  maximumCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const FundingReservationSchema = z.object({
  reservationId: ReferenceSchema,
  reservedMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const CompletionCostShape = {
  actualCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const CompletionSchema = z.discriminatedUnion("executionState", [
  z.object({
    ...CompletionCostShape,
    executionState: z.literal("succeeded"),
    outcomeCode: z.enum(["transcript", "no_speech"]),
  }).strict(),
  z.object({
    ...CompletionCostShape,
    executionState: z.literal("failed"),
    outcomeCode: z.enum(["invalid_media", "timeout", "provider_failure"]),
  }).strict(),
  z.object({
    ...CompletionCostShape,
    executionState: z.literal("uncertain"),
    outcomeCode: z.enum(["timeout", "provider_failure", "cancelled"]),
  }).strict(),
]);

export interface SpeechOperationIdentity {
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
}

export interface SpeechOperationRecord {
  identity: SpeechOperationIdentity;
  requestId: string;
  sourceKind: SpeechSourceKind | null;
  contentFingerprint: string | null;
  policyRevision: string | null;
  adapterId: string | null;
  modelId: string | null;
  fundingReservationId: string | null;
  executionState: SpeechExecutionState;
  cancellationRequested: boolean;
  tombstone: boolean;
  executionStarted: boolean;
  outcomeCode: SpeechOutcomeCode | null;
  audioDurationMs: number | null;
  reservedMicrousd: number | null;
  actualCostMicrousd: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export class SpeechOperationConflictError extends Error {
  readonly code = "request_conflict" as const;

  constructor() {
    super("Speech operation request identity was reused");
    this.name = "SpeechOperationConflictError";
  }
}

export class SpeechOperationStateError extends Error {
  readonly code = "invalid_state" as const;

  constructor() {
    super("Speech operation is not in the required state");
    this.name = "SpeechOperationStateError";
  }
}

export class SpeechOperationRateLimitError extends Error {
  readonly code = "rate_limited" as const;

  constructor() {
    super("Speech operation admission limit reached");
    this.name = "SpeechOperationRateLimitError";
  }
}

function exactNullableInteger(value: unknown): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Speech operation numeric value is invalid");
  return parsed;
}

function operationRecord(row: SpeechOperationsTable): SpeechOperationRecord {
  const executionState = SpeechExecutionStateSchema.parse(row.execution_state);
  return {
    identity: { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot },
    requestId: SpeechRequestIdSchema.parse(row.operation_id),
    sourceKind: row.source_kind === null ? null : SpeechSourceKindSchema.parse(row.source_kind),
    contentFingerprint: row.content_fingerprint,
    policyRevision: row.policy_revision,
    adapterId: row.adapter_id,
    modelId: row.model_id,
    fundingReservationId: row.funding_reservation_id,
    executionState,
    cancellationRequested: row.cancellation_requested,
    tombstone: row.tombstone,
    executionStarted: row.dispatch_claimed_at !== null || ["succeeded", "failed", "uncertain"].includes(executionState),
    outcomeCode: row.safe_outcome_code === null ? null : SpeechOutcomeCodeSchema.parse(row.safe_outcome_code),
    audioDurationMs: exactNullableInteger(row.audio_duration_ms),
    reservedMicrousd: exactNullableInteger(row.reserved_microusd),
    actualCostMicrousd: exactNullableInteger(row.actual_microusd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function requestTimestamp(requestId: string): number {
  return Number(requestId.slice(3, 16));
}

function matchesImmutableAdmission(
  row: SpeechOperationsTable,
  admission: z.output<typeof AdmissionSchema>,
): boolean {
  return row.content_fingerprint === admission.contentFingerprint
    && row.source_kind === admission.sourceKind
    && row.policy_revision === admission.policyRevision
    && row.adapter_id === admission.adapterId
    && row.model_id === admission.modelId
    && exactNullableInteger(row.audio_duration_ms) === admission.audioDurationMs;
}

export function createSpeechOperationsRepository(options: {
  db: PlatformDB;
  now?: () => Date;
  maximumRequestAgeMs?: number;
  futureClockSkewMs?: number;
  metadataRetentionMs?: number;
  maximumActiveOperations?: number;
  maximumActiveOperationsPerOwner?: number;
  maximumAdmissionsPerOwner?: number;
  admissionWindowMs?: number;
}) {
  const now = options.now ?? (() => new Date());
  const maximumRequestAgeMs = options.maximumRequestAgeMs ?? 5 * 60_000;
  const futureClockSkewMs = options.futureClockSkewMs ?? 30_000;
  const metadataRetentionMs = options.metadataRetentionMs ?? 24 * 60 * 60_000;
  const maximumActiveOperations = options.maximumActiveOperations ?? 16;
  const maximumActiveOperationsPerOwner = options.maximumActiveOperationsPerOwner
    ?? Math.min(2, maximumActiveOperations);
  const maximumAdmissionsPerOwner = options.maximumAdmissionsPerOwner ?? 10;
  const admissionWindowMs = options.admissionWindowMs ?? 60_000;
  if (maximumRequestAgeMs < 60_000 || maximumRequestAgeMs > 24 * 60 * 60_000
    || futureClockSkewMs < 0 || futureClockSkewMs > 5 * 60_000
    || metadataRetentionMs < maximumRequestAgeMs || metadataRetentionMs > 30 * 24 * 60 * 60_000
    || !Number.isSafeInteger(maximumActiveOperations) || maximumActiveOperations < 1 || maximumActiveOperations > 1_000
    || !Number.isSafeInteger(maximumActiveOperationsPerOwner) || maximumActiveOperationsPerOwner < 1
    || maximumActiveOperationsPerOwner > maximumActiveOperations
    || !Number.isSafeInteger(maximumAdmissionsPerOwner) || maximumAdmissionsPerOwner < 1
    || maximumAdmissionsPerOwner > 10_000
    || !Number.isSafeInteger(admissionWindowMs) || admissionWindowMs < 1_000 || admissionWindowMs > 60 * 60_000) {
    throw new Error("Speech operation retention policy is invalid");
  }

  function parseIdentity(identity: SpeechOperationIdentity) {
    return IdentitySchema.parse(identity);
  }

  function validateRequestAge(requestId: string, checked: Date): void {
    const timestamp = requestTimestamp(requestId);
    if (!Number.isSafeInteger(timestamp)
      || timestamp < checked.getTime() - maximumRequestAgeMs
      || timestamp > checked.getTime() + futureClockSkewMs) {
      throw new SpeechOperationConflictError();
    }
  }

  async function scopedRow(
    executor: PlatformDB["executor"],
    identity: SpeechOperationIdentity,
    requestId: string,
    lock = false,
  ) {
    let query = executor.selectFrom("speech_operations").selectAll()
      .where("owner_id", "=", identity.ownerId)
      .where("machine_id", "=", identity.machineId)
      .where("runtime_slot", "=", identity.runtimeSlot)
      .where("operation_id", "=", requestId);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  async function get(identityInput: SpeechOperationIdentity, requestIdInput: string) {
    const identity = parseIdentity(identityInput);
    const requestId = SpeechRequestIdSchema.parse(requestIdInput);
    await options.db.ready;
    const row = await scopedRow(options.db.executor, identity, requestId);
    return row ? operationRecord(row) : undefined;
  }

  async function admit(
    input: z.input<typeof AdmissionSchema>,
    reserveFunding: (trx: Transaction<PlatformDatabase>) => Promise<z.input<typeof FundingReservationSchema>>,
  ): Promise<SpeechOperationRecord> {
    const admission = AdmissionSchema.parse(input);
    const checked = now();
    validateRequestAge(admission.requestId, checked);
    const checkedAt = checked.toISOString();
    const expiresAt = new Date(checked.getTime() + metadataRetentionMs).toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const existing = await scopedRow(trx.executor, admission.identity, admission.requestId);
      if (existing) {
        if (existing.tombstone) return operationRecord(existing);
        if (!matchesImmutableAdmission(existing, admission)) {
          throw new SpeechOperationConflictError();
        }
        return operationRecord(existing);
      }
      await sql`SELECT pg_advisory_xact_lock(hashtext('matrix-speech-admission'))`.execute(trx.executor);
      const activeStates: SpeechExecutionState[] = ["received", "reserved", "dispatching"];
      const active = await trx.executor.selectFrom("speech_operations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("execution_state", "in", activeStates)
        .where("expires_at", ">", checkedAt).executeTakeFirstOrThrow();
      const ownerActive = await trx.executor.selectFrom("speech_operations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("owner_id", "=", admission.identity.ownerId)
        .where("execution_state", "in", activeStates)
        .where("expires_at", ">", checkedAt).executeTakeFirstOrThrow();
      const ownerAdmissions = await trx.executor.selectFrom("speech_operations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("owner_id", "=", admission.identity.ownerId)
        .where("source_kind", "is not", null)
        .where("created_at", ">=", new Date(checked.getTime() - admissionWindowMs).toISOString())
        .executeTakeFirstOrThrow();
      if (Number(active.count) >= maximumActiveOperations
        || Number(ownerActive.count) >= maximumActiveOperationsPerOwner
        || Number(ownerAdmissions.count) >= maximumAdmissionsPerOwner) {
        throw new SpeechOperationRateLimitError();
      }
      const inserted = await trx.executor.insertInto("speech_operations").values({
        owner_id: admission.identity.ownerId,
        machine_id: admission.identity.machineId,
        runtime_slot: admission.identity.runtimeSlot,
        operation_id: admission.requestId,
        source_kind: admission.sourceKind,
        content_fingerprint: admission.contentFingerprint,
        policy_revision: admission.policyRevision,
        adapter_id: admission.adapterId,
        model_id: admission.modelId,
        funding_reservation_id: null,
        execution_state: "received",
        cancellation_requested: false,
        tombstone: false,
        dispatch_claimed_at: null,
        safe_outcome_code: null,
        audio_duration_ms: admission.audioDurationMs,
        reserved_microusd: null,
        actual_microusd: null,
        created_at: checkedAt,
        updated_at: checkedAt,
        expires_at: expiresAt,
      }).onConflict((conflict) => conflict.columns([
        "owner_id", "machine_id", "runtime_slot", "operation_id",
      ]).doNothing()).returningAll().executeTakeFirst();
      if (!inserted) {
        const raced = await scopedRow(trx.executor, admission.identity, admission.requestId);
        if (!raced) throw new SpeechOperationConflictError();
        if (!raced.tombstone && !matchesImmutableAdmission(raced, admission)) {
          throw new SpeechOperationConflictError();
        }
        return operationRecord(raced);
      }
      const reservation = FundingReservationSchema.parse(await reserveFunding(
        trx.executor as Transaction<PlatformDatabase>,
      ));
      if (reservation.reservedMicrousd > admission.maximumCostMicrousd) {
        throw new Error("Speech funding reservation exceeded its admission maximum");
      }
      const updated = await trx.executor.updateTable("speech_operations").set({
        funding_reservation_id: reservation.reservationId,
        reserved_microusd: reservation.reservedMicrousd,
        execution_state: "reserved",
        updated_at: checkedAt,
      }).where("owner_id", "=", admission.identity.ownerId)
        .where("machine_id", "=", admission.identity.machineId)
        .where("runtime_slot", "=", admission.identity.runtimeSlot)
        .where("operation_id", "=", admission.requestId)
        .where("execution_state", "=", "received").returningAll().executeTakeFirst();
      if (!updated) throw new SpeechOperationStateError();
      return operationRecord(updated);
    });
  }

  async function claimDispatch(
    identityInput: SpeechOperationIdentity,
    requestIdInput: string,
    startFunding: (trx: Transaction<PlatformDatabase>, reservationId: string) => Promise<void> = async () => undefined,
  ) {
    const identity = parseIdentity(identityInput);
    const requestId = SpeechRequestIdSchema.parse(requestIdInput);
    const checkedAt = now().toISOString();
    await options.db.ready;
    const result = await options.db.transaction(async (trx) => {
      const current = await scopedRow(trx.executor, identity, requestId, true);
      if (!current) throw new SpeechOperationStateError();
      if (current.execution_state !== "reserved" || current.cancellation_requested) {
        return { claimed: false, operation: operationRecord(current) } as const;
      }
      if (!current.funding_reservation_id) throw new SpeechOperationStateError();
      await startFunding(
        trx.executor as Transaction<PlatformDatabase>,
        current.funding_reservation_id,
      );
      const updated = await trx.executor.updateTable("speech_operations").set({
        execution_state: "dispatching",
        dispatch_claimed_at: checkedAt,
        updated_at: checkedAt,
      }).where("owner_id", "=", identity.ownerId)
        .where("machine_id", "=", identity.machineId)
        .where("runtime_slot", "=", identity.runtimeSlot)
        .where("operation_id", "=", requestId)
        .where("execution_state", "=", "reserved")
        .where("cancellation_requested", "=", false).returningAll().executeTakeFirst();
      if (!updated) return { retryRead: true } as const;
      return { claimed: true, operation: operationRecord(updated) } as const;
    });
    if (!("retryRead" in result)) return result;
    const latest = await scopedRow(options.db.executor, identity, requestId);
    if (!latest) throw new SpeechOperationStateError();
    return { claimed: false, operation: operationRecord(latest) } as const;
  }

  async function complete(
    identityInput: SpeechOperationIdentity,
    requestIdInput: string,
    completionInput: z.input<typeof CompletionSchema>,
    settleFunding: (
      trx: Transaction<PlatformDatabase>,
      reservationId: string,
      actualCostMicrousd: number,
    ) => Promise<void>,
  ) {
    const identity = parseIdentity(identityInput);
    const requestId = SpeechRequestIdSchema.parse(requestIdInput);
    const completion = CompletionSchema.parse(completionInput);
    const checkedAt = now().toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const row = await scopedRow(trx.executor, identity, requestId, true);
      if (!row) throw new SpeechOperationStateError();
      if (["succeeded", "failed", "uncertain"].includes(row.execution_state)) return operationRecord(row);
      if (row.execution_state !== "dispatching" || !row.funding_reservation_id) {
        throw new SpeechOperationStateError();
      }
      await settleFunding(
        trx.executor as Transaction<PlatformDatabase>,
        row.funding_reservation_id,
        completion.actualCostMicrousd,
      );
      const updated = await trx.executor.updateTable("speech_operations").set({
        execution_state: completion.executionState,
        safe_outcome_code: completion.outcomeCode,
        actual_microusd: completion.actualCostMicrousd,
        updated_at: checkedAt,
      }).where("owner_id", "=", identity.ownerId)
        .where("machine_id", "=", identity.machineId)
        .where("runtime_slot", "=", identity.runtimeSlot)
        .where("operation_id", "=", requestId)
        .where("execution_state", "=", "dispatching").returningAll().executeTakeFirst();
      if (!updated) throw new SpeechOperationStateError();
      return operationRecord(updated);
    });
  }

  async function cancel(
    identityInput: SpeechOperationIdentity,
    requestIdInput: string,
    releaseFunding: (trx: Transaction<PlatformDatabase>, reservationId: string) => Promise<void>,
  ) {
    const identity = parseIdentity(identityInput);
    const requestId = SpeechRequestIdSchema.parse(requestIdInput);
    const checked = now();
    validateRequestAge(requestId, checked);
    const checkedAt = checked.toISOString();
    const expiresAt = new Date(checked.getTime() + metadataRetentionMs).toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      await trx.executor.insertInto("speech_operations").values({
        owner_id: identity.ownerId,
        machine_id: identity.machineId,
        runtime_slot: identity.runtimeSlot,
        operation_id: requestId,
        source_kind: null,
        content_fingerprint: null,
        policy_revision: null,
        adapter_id: null,
        model_id: null,
        funding_reservation_id: null,
        execution_state: "cancelled",
        cancellation_requested: true,
        tombstone: true,
        dispatch_claimed_at: null,
        safe_outcome_code: "cancelled",
        audio_duration_ms: null,
        reserved_microusd: null,
        actual_microusd: null,
        created_at: checkedAt,
        updated_at: checkedAt,
        expires_at: expiresAt,
      }).onConflict((conflict) => conflict.columns([
        "owner_id", "machine_id", "runtime_slot", "operation_id",
      ]).doNothing()).execute();
      const row = await scopedRow(trx.executor, identity, requestId, true);
      if (!row) throw new SpeechOperationStateError();
      if (row.tombstone) return operationRecord(row);
      if (row.execution_state === "reserved") {
        if (!row.funding_reservation_id) throw new SpeechOperationStateError();
        await releaseFunding(trx.executor as Transaction<PlatformDatabase>, row.funding_reservation_id);
        const updated = await trx.executor.updateTable("speech_operations").set({
          execution_state: "cancelled",
          cancellation_requested: true,
          safe_outcome_code: "cancelled",
          updated_at: checkedAt,
        }).where("owner_id", "=", identity.ownerId)
          .where("machine_id", "=", identity.machineId)
          .where("runtime_slot", "=", identity.runtimeSlot)
          .where("operation_id", "=", requestId)
          .where("execution_state", "=", "reserved").returningAll().executeTakeFirst();
        if (!updated) throw new SpeechOperationStateError();
        return operationRecord(updated);
      }
      if (!row.cancellation_requested) {
        const updated = await trx.executor.updateTable("speech_operations").set({
          cancellation_requested: true,
          updated_at: checkedAt,
        }).where("owner_id", "=", identity.ownerId)
          .where("machine_id", "=", identity.machineId)
          .where("runtime_slot", "=", identity.runtimeSlot)
          .where("operation_id", "=", requestId).returningAll().executeTakeFirstOrThrow();
        return operationRecord(updated);
      }
      return operationRecord(row);
    });
  }

  return { admit, cancel, claimDispatch, complete, get };
}

export type SpeechOperationsRepository = ReturnType<typeof createSpeechOperationsRepository>;
