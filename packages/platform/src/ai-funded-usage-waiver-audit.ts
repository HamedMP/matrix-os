import { createHash } from "node:crypto";
import { IsoTimestampSchema, FundedAiSettlementResponseSchema } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { FundedReferenceSchema, exactInteger } from "./ai-funded-metering-helpers.js";
import { readFundedUsageAuthorization } from "./ai-funded-recovery-audit.js";

export const USAGE_WAIVER_GRACE_MS = 10 * 60_000;
export const USAGE_WAIVER_MIN_AGE_MS = 16 * 60_000;
export const USAGE_WAIVER_MAX_RECORDS = 10;
export const USAGE_WAIVER_MAX_LIABILITY_MICROUSD = 50_000_000;
const Money = z.number().int().nonnegative().max(USAGE_WAIVER_MAX_LIABILITY_MICROUSD);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const UsageWaiverReservationSchema = z.object({
  reservationId: FundedReferenceSchema, tokenId: FundedReferenceSchema, requestId: FundedReferenceSchema,
  startedAt: IsoTimestampSchema, expiresAt: IsoTimestampSchema, reservedMicrousd: Money.positive(),
  promotionalReservedMicrousd: Money.nullable(), addonReservedMicrousd: Money.nullable(),
  maximumLiabilityMicrousd: Money.positive(), authorizationSha256: Hash,
  fundingAllocationSha256: Hash,
  executionAdmissionReleaseSha256: Hash.nullable(),
}).strict();
export const ExpiredUsageWaiverRequestSchema = z.object({
  identity: z.object({ ownerId: FundedReferenceSchema, machineId: FundedReferenceSchema,
    runtimeSlot: z.literal("primary") }).strict(),
  expectedRuntimeTokenEpoch: z.number().int().positive(),
  accountDeletionMode: z.enum(["configured", "disabled"]),
  reviewer: FundedReferenceSchema,
  evidenceRef: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  reason: z.literal("expired_unknown_usage"), acceptPlatformLiability: z.literal(true),
  expectedReleasedMicrousd: Money.positive(), expectedMaximumLiabilityMicrousd: Money.positive(),
  reservations: z.array(UsageWaiverReservationSchema).min(1).max(USAGE_WAIVER_MAX_RECORDS),
}).strict().superRefine((request, ctx) => {
  const ids = request.reservations.map((item) => item.reservationId);
  if (new Set(ids).size !== ids.length
    || request.reservations.reduce((sum, item) => sum + item.reservedMicrousd, 0) !== request.expectedReleasedMicrousd
    || request.reservations.reduce((sum, item) => sum + item.maximumLiabilityMicrousd, 0) !== request.expectedMaximumLiabilityMicrousd) {
    ctx.addIssue({ code: "custom", message: "Duplicate reservation or mismatched reviewed total" });
  }
});
export type ExpiredUsageWaiverRequest = z.infer<typeof ExpiredUsageWaiverRequestSchema>;
export const UsageWaiverResponseSchema = z.object({
  contractVersion: z.literal(1), mode: z.enum(["dry-run", "applied"]), fingerprint: Hash,
  releasedMicrousd: Money, maximumLiabilityMicrousd: Money, usageKnown: z.literal(false),
  waivedAt: IsoTimestampSchema,
}).strict();
const AuditSchema = z.object({ request: ExpiredUsageWaiverRequestSchema, response: UsageWaiverResponseSchema }).strict();
export const waiverHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const waiverFingerprint = (input: ExpiredUsageWaiverRequest) => waiverHash(JSON.stringify(input));

/** Exact stored financial capture, including earlier admission-only audit, survives waiver. */
export function assertWaiverSnapshot(row: Selectable<AiFundedUsageReservationsTable>,
  request: ExpiredUsageWaiverRequest, expected: ExpiredUsageWaiverRequest["reservations"][number]) {
  if (Buffer.byteLength(row.authorization_response) > 64 * 1024) throw new AiFundedPolicyError("idempotency_conflict");
  const captured = readFundedUsageAuthorization(row);
  if (row.owner_id !== request.identity.ownerId || row.machine_id !== request.identity.machineId
    || row.runtime_slot !== request.identity.runtimeSlot || row.reservation_id !== expected.reservationId
    || row.token_id !== expected.tokenId || row.request_id !== expected.requestId
    || row.started_at !== expected.startedAt || row.expires_at !== expected.expiresAt
    || exactInteger(row.reserved_microusd) !== expected.reservedMicrousd
    || (row.promotional_reserved_microusd === null ? null : exactInteger(row.promotional_reserved_microusd)) !== expected.promotionalReservedMicrousd
    || (row.addon_reserved_microusd === null ? null : exactInteger(row.addon_reserved_microusd)) !== expected.addonReservedMicrousd
    || captured.reservation.maxCostMicrousd !== expected.maximumLiabilityMicrousd
    || waiverHash(row.authorization_response) !== expected.authorizationSha256
    || (row.execution_admission_release === null ? null : waiverHash(row.execution_admission_release)) !== expected.executionAdmissionReleaseSha256) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
}

/** Null actual is closed for owner admission only when this durable audit proves it. */
export function readUsageWaiverAudit(row: Selectable<AiFundedUsageReservationsTable>) {
  try {
    if (!row.charge_waiver || Buffer.byteLength(row.charge_waiver) > 64 * 1024) throw new Error("Missing waiver audit");
    const audit = AuditSchema.parse(JSON.parse(row.charge_waiver));
    const expected = audit.request.reservations.find((item) => item.reservationId === row.reservation_id);
    if (!expected) throw new Error("Missing waiver locator");
    assertWaiverSnapshot(row, audit.request, expected);
    const { response, request } = audit;
    const waived = Date.parse(response.waivedAt);
    if (response.mode !== "applied" || response.fingerprint !== waiverFingerprint(request)
      || response.releasedMicrousd !== request.expectedReleasedMicrousd
      || response.maximumLiabilityMicrousd !== request.expectedMaximumLiabilityMicrousd
      || waived < Date.parse(expected.expiresAt) + USAGE_WAIVER_GRACE_MS
      || waived < Date.parse(expected.startedAt) + USAGE_WAIVER_MIN_AGE_MS
      || (row.status !== "waived" && row.status !== "settled")
      || (row.status === "waived" && (row.actual_microusd !== null || row.settlement_response !== null || row.settled_at !== null))
      || (row.status === "settled" && (row.actual_microusd === null || row.settlement_response === null))) {
      throw new Error("Invalid waiver disposition");
    }
    if (row.status === "settled") {
      const settlement = FundedAiSettlementResponseSchema.parse(JSON.parse(row.settlement_response!));
      if (settlement.reservationId !== row.reservation_id || settlement.requestId !== row.request_id
        || settlement.tokenId !== row.token_id || settlement.actualCostMicrousd !== exactInteger(row.actual_microusd)
        || settlement.chargedCostMicrousd !== 0 || settlement.matrixAbsorbedMicrousd !== settlement.actualCostMicrousd
        || settlement.releasedMicrousd !== 0 || settlement.settledAt !== row.settled_at || row.finalization_mode !== "exact"
        || settlement.actualCostMicrousd > expected.maximumLiabilityMicrousd) {
        throw new Error("Invalid waived settlement");
      }
    }
    return audit;
  } catch (error) {
    if (error instanceof AiFundedPolicyError) throw error;
    throw new AiFundedPolicyError("idempotency_conflict");
  }
}
