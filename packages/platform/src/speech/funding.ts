import { readSpeechAuthorization } from "./reservation-policy.js";
import { settlePostpaidSpeech } from "./funding-postpaid.js";
import { releaseSpeechAllowance } from "../ai-funded-customer-charge-release.js";
import { readFundedRecoveryAudit } from "../ai-funded-recovery-audit.js";
import { createHash, createHmac } from "node:crypto";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDatabase } from "../db.js";
import { recordUsageFunding } from "../ai-funded-metering-helpers.js";
import { AiFundedPolicyError } from "../ai-funded-policy-errors.js";
import {
  debitAttributedPromotionalGrants,
  reconcileExpiredPromotionalCredit,
  reservationDebitSplit,
  fundingSourceAvailability,
} from "../ai-funded-reservation-sources.js";
import { ensureSpeechMonthlyAllowance, SpeechAllowanceError } from "./allowance.js";
import { isSpeechMonthlyAuthorization } from "./reservation-policy.js";
import type { SpeechFundingPort } from "./service.js";

const ReferenceSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const IdentitySchema = z.object({
  ownerId: ReferenceSchema,
  machineId: ReferenceSchema,
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
}).strict();
const ReserveSchema = z.object({
  identity: IdentitySchema,
  requestId: ReferenceSchema,
  policyRevision: ReferenceSchema,
  modelId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  maximumCostMicrousd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const ReservationIdSchema = ReferenceSchema;
const MoneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ACTIVE_SPEECH_AUDIENCE = "matrix-platform-speech";
const ACTIVE_SPEECH_SCOPE = "speech:transcribe";

export class SpeechFundingError extends Error {
  constructor(readonly code: "unavailable" | "allowance_exhausted") {
    super("Speech funding is unavailable");
    this.name = "SpeechFundingError";
  }
}

function exactInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Speech funding total exceeds safe integer range");
  return parsed;
}

function utcMonthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

function platformCredentialId(identity: z.output<typeof IdentitySchema>, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(`${identity.ownerId}\0${identity.machineId}\0${identity.runtimeSlot}`)
    .digest("hex")
    .slice(0, 48);
  return `speech_${digest}`;
}

function payloadHash(input: z.output<typeof ReserveSchema>): string {
  return createHash("sha256").update(JSON.stringify({
    identity: input.identity,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    modelId: input.modelId,
    maximumCostMicrousd: input.maximumCostMicrousd,
  })).digest("hex");
}

function mapFundingError(error: unknown): never {
  if (error instanceof SpeechFundingError) throw error;
  if (error instanceof AiFundedPolicyError) {
    if (error.code === "insufficient_credit" || error.code === "budget_exceeded") {
      throw new SpeechFundingError("allowance_exhausted");
    }
    throw new SpeechFundingError("unavailable");
  }
  throw error;
}

export function createAiFundedSpeechFundingPort(options: {
  allowedSources: readonly ("promotional" | "addon")[];
  credentialHashSecret: string;
  reservationIdFactory: () => string;
  now?: () => Date;
  reservationTtlMs?: number;
  inFlightTtlMs?: number;
  credentialTtlMs?: number;
  monthlyAllowance?: {
    monthlyBudgetMicrousd: number;
    monthlyPromotionalCreditMicrousd: number;
  };
}): SpeechFundingPort {
  if (options.credentialHashSecret.length < 32) {
    throw new Error("Speech funding credential secret must be at least 32 characters");
  }
  const allowedSources = [...new Set(options.allowedSources)];
  if (allowedSources.length < 1 || allowedSources.some((source) => source !== "promotional" && source !== "addon")) {
    throw new Error("Speech funding sources are invalid");
  }
  const sourcePolicy = {
    promotional: allowedSources.includes("promotional"),
    addon: allowedSources.includes("addon"),
    ...(options.monthlyAllowance ? { promotionalGrantNamespace: "speech_monthly" as const } : {}),
  };
  if (options.monthlyAllowance
    && ((options.monthlyAllowance.monthlyPromotionalCreditMicrousd > 0
      && !allowedSources.includes("promotional"))
      || !Number.isSafeInteger(options.monthlyAllowance.monthlyBudgetMicrousd)
      || options.monthlyAllowance.monthlyBudgetMicrousd <= 0
      || !Number.isSafeInteger(options.monthlyAllowance.monthlyPromotionalCreditMicrousd)
      || options.monthlyAllowance.monthlyPromotionalCreditMicrousd < 0
      || options.monthlyAllowance.monthlyPromotionalCreditMicrousd
        > options.monthlyAllowance.monthlyBudgetMicrousd)) {
    throw new Error("Speech monthly allowance is invalid");
  }
  const now = options.now ?? (() => new Date());
  const reservationTtlMs = options.reservationTtlMs ?? 5 * 60_000;
  const inFlightTtlMs = options.inFlightTtlMs ?? 30 * 60_000;
  const credentialTtlMs = options.credentialTtlMs ?? 24 * 60 * 60_000;
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 30_000 || reservationTtlMs > 15 * 60_000
    || !Number.isSafeInteger(inFlightTtlMs) || inFlightTtlMs < 60_000 || inFlightTtlMs > 60 * 60_000
    || !Number.isSafeInteger(credentialTtlMs) || credentialTtlMs < 5 * 60_000
    || credentialTtlMs > 30 * 24 * 60 * 60_000) {
    throw new Error("Speech funding time limits are invalid");
  }

  async function ensurePlatformCredential(
    trx: Transaction<PlatformDatabase>,
    identity: z.output<typeof IdentitySchema>,
    checkedAt: string,
  ): Promise<string> {
    const tokenId = platformCredentialId(identity, options.credentialHashSecret);
    const tokenHash = createHmac("sha256", options.credentialHashSecret)
      .update(`${tokenId}\0${identity.ownerId}\0${identity.machineId}\0${identity.runtimeSlot}`)
      .digest("hex");
    const expiresAt = new Date(Date.parse(checkedAt) + credentialTtlMs).toISOString();
    await trx.insertInto("ai_runtime_credentials").values({
      token_id: tokenId,
      token_hash: tokenHash,
      owner_id: identity.ownerId,
      machine_id: identity.machineId,
      runtime_slot: identity.runtimeSlot,
      audience: ACTIVE_SPEECH_AUDIENCE,
      scope: ACTIVE_SPEECH_SCOPE,
      issued_at: checkedAt,
      expires_at: expiresAt,
      revoked_at: null,
    }).onConflict((conflict) => conflict.column("token_id").doNothing()).execute();
    const stored = await trx.selectFrom("ai_runtime_credentials").selectAll()
      .where("token_id", "=", tokenId).executeTakeFirstOrThrow();
    if (stored.token_hash !== tokenHash || stored.owner_id !== identity.ownerId
      || stored.machine_id !== identity.machineId || stored.runtime_slot !== identity.runtimeSlot
      || stored.audience !== ACTIVE_SPEECH_AUDIENCE || stored.scope !== ACTIVE_SPEECH_SCOPE
      || stored.revoked_at !== null) {
      throw new SpeechFundingError("unavailable");
    }
    await trx.updateTable("ai_runtime_credentials").set({
      issued_at: checkedAt,
      expires_at: expiresAt,
    }).where("token_id", "=", tokenId)
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null).executeTakeFirstOrThrow();
    return tokenId;
  }

  async function reserve(
    trx: Transaction<PlatformDatabase>,
    rawInput: Parameters<SpeechFundingPort["reserve"]>[1],
  ) {
    const input = ReserveSchema.parse(rawInput);
    try {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${input.identity.ownerId}`}, 0))`.execute(trx);
      const machine = await trx.selectFrom("user_machines").select([
        "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
      ]).where("machine_id", "=", input.identity.machineId).forNoKeyUpdate().executeTakeFirst();
      await trx.selectFrom("ai_funded_runtime_balances").select("machine_id").where("machine_id", "=", input.identity.machineId).forUpdate().executeTakeFirst();
      const checked = now();
      const checkedAt = checked.toISOString();
      const periodStart = utcMonthStart(checked);
      const runtime = options.monthlyAllowance ? undefined : await trx.selectFrom("ai_funded_runtime_policies").select([
        "owner_id", "runtime_slot", "monthly_budget_microusd",
      ]).where("machine_id", "=", input.identity.machineId).executeTakeFirst();
      const allowance = options.monthlyAllowance
        ? await ensureSpeechMonthlyAllowance(trx, input.identity, {
          ...options.monthlyAllowance,
          now: checked,
        })
        : undefined;
      const restriction = await trx.selectFrom("ai_funded_credit_restrictions")
        .select(["debt_microusd", "frozen"]).where("machine_id", "=", input.identity.machineId)
        .forUpdate().executeTakeFirst();
      if (!machine || (!runtime && !allowance) || machine.clerk_user_id !== input.identity.ownerId
        || machine.runtime_slot !== input.identity.runtimeSlot || machine.status !== "running"
        || machine.activation_state !== "authorized" || machine.deleted_at !== null
        || (runtime !== undefined && (runtime.owner_id !== input.identity.ownerId
          || runtime.runtime_slot !== input.identity.runtimeSlot))
        || (allowance !== undefined && (allowance.owner_id !== input.identity.ownerId
          || allowance.runtime_slot !== input.identity.runtimeSlot || allowance.enabled !== true))
        || restriction?.frozen === true || exactInteger(restriction?.debt_microusd ?? 0) > 0) {
        throw new SpeechFundingError("unavailable");
      }
      const tokenId = await ensurePlatformCredential(trx, input.identity, checkedAt);
      const hash = payloadHash(input);
      const existing = await trx.selectFrom("ai_funded_usage_reservations")
        .select(["reservation_id", "payload_hash", "reserved_microusd", "status", "customer_charge_release"])
        .where("token_id", "=", tokenId).where("request_id", "=", input.requestId)
        .executeTakeFirst();
      if (existing) {
        if (existing.payload_hash !== hash || !["reserved", "in_flight"].includes(existing.status) || existing.customer_charge_release !== null) throw new SpeechFundingError("unavailable");
        return {
          reservationId: ReservationIdSchema.parse(existing.reservation_id),
          reservedMicrousd: exactInteger(existing.reserved_microusd),
        };
      }
      await reconcileExpiredPromotionalCredit(trx, input.identity, checkedAt);
      const reset = options.monthlyAllowance
        ? await trx.selectFrom("ai_funded_runtime_balances").selectAll()
          .where("machine_id", "=", input.identity.machineId)
          .where("owner_id", "=", input.identity.ownerId)
          .where("runtime_slot", "=", input.identity.runtimeSlot)
          .forUpdate().executeTakeFirst()
        : await trx.updateTable("ai_funded_runtime_balances").set({
          month_period_start: periodStart,
          month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${periodStart} THEN month_spent_microusd ELSE 0 END`,
          month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${periodStart} THEN month_reserved_microusd ELSE 0 END`,
          updated_at: checkedAt,
        }).where("machine_id", "=", input.identity.machineId)
          .where("owner_id", "=", input.identity.ownerId)
          .where("runtime_slot", "=", input.identity.runtimeSlot)
          .returningAll().executeTakeFirst();
      if (!reset) throw new SpeechFundingError("unavailable");
      const monthlyBudget = exactInteger(
        allowance?.monthly_budget_microusd ?? runtime?.monthly_budget_microusd,
      );
      const reserved = reset;
      const availability = await fundingSourceAvailability(trx, input.identity, reserved, checkedAt, sourcePolicy);
      if (Math.min(availability.availableMicrousd, exactInteger(reserved.credit_balance_microusd)
        - exactInteger(reserved.reserved_microusd) - exactInteger(reserved.funding_shortfall_microusd)) <= 0
        || (!allowance && monthlyBudget - exactInteger(reserved.month_spent_microusd) - exactInteger(reserved.month_reserved_microusd) <= 0)) {
        throw new SpeechFundingError("allowance_exhausted");
      }
      if (allowance) {
        const speechReserved = await trx.updateTable("speech_runtime_allowances").set({
          period_reserved_microusd: sql<number>`period_reserved_microusd + ${input.maximumCostMicrousd}`,
          updated_at: checkedAt,
        }).where("machine_id", "=", input.identity.machineId)
          .where("owner_id", "=", input.identity.ownerId)
          .where("runtime_slot", "=", input.identity.runtimeSlot)
          .where("enabled", "=", true)
          .where("period_start", "=", periodStart)
          .where(sql<boolean>`${monthlyBudget} - period_spent_microusd - period_reserved_microusd >= ${input.maximumCostMicrousd}`)
          .returning("machine_id").executeTakeFirst();
        if (!speechReserved) throw new SpeechFundingError("allowance_exhausted");
      }
      const reservationId = ReservationIdSchema.parse(options.reservationIdFactory());
      const expiresAt = new Date(checked.getTime() + reservationTtlMs).toISOString();
      await trx.insertInto("ai_funded_usage_reservations").values({
        reservation_id: reservationId,
        request_id: input.requestId,
        payload_hash: hash,
        authorization_response: JSON.stringify({
          capability: ACTIVE_SPEECH_SCOPE,
          policyRevision: input.policyRevision,
          ...(allowance ? { fundingPolicy: "speech_monthly_v1" } : {}),
          reservation: { billingMode: "usage", billingPolicy: "postpaid", reservedMicrousd: 0, maxCostMicrousd: input.maximumCostMicrousd },
          allowanceReservedMicrousd: allowance ? input.maximumCostMicrousd : 0,
          allowancePeriodStart: allowance ? periodStart : null,
        }),
        settlement_response: null,
        finalization_mode: null,
        start_response: null,
        release_response: null,
        release_reason: null,
        token_id: tokenId,
        owner_id: input.identity.ownerId,
        machine_id: input.identity.machineId,
        runtime_slot: input.identity.runtimeSlot,
        model_id: input.modelId,
        reserved_microusd: 0,
        promotional_reserved_microusd: 0,
        addon_reserved_microusd: 0,
        actual_microusd: null,
        period_start: periodStart,
        status: "reserved",
        created_at: checkedAt,
        started_at: null,
        expires_at: expiresAt,
        settled_at: null,
        released_at: null,
      }).execute();
      return { reservationId, reservedMicrousd: 0 };
    } catch (error: unknown) {
      if (error instanceof SpeechAllowanceError) throw new SpeechFundingError("unavailable");
      return mapFundingError(error);
    }
  }

  async function speechReservation(
    trx: Transaction<PlatformDatabase>,
    reservationId: string,
    activeAt?: string,
  ) {
    const locator = await trx.selectFrom("ai_funded_usage_reservations").select(["owner_id", "machine_id"])
      .where("reservation_id", "=", ReservationIdSchema.parse(reservationId)).executeTakeFirst();
    if (!locator) return undefined;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${locator.owner_id}`}, 0))`.execute(trx);
    await trx.selectFrom("user_machines").select("machine_id").where("machine_id", "=", locator.machine_id).forNoKeyUpdate().executeTakeFirstOrThrow();
    let query = trx.selectFrom("ai_funded_usage_reservations as reservation")
      .innerJoin("ai_runtime_credentials as credential", "credential.token_id", "reservation.token_id")
      .selectAll("reservation")
      .where("reservation.reservation_id", "=", ReservationIdSchema.parse(reservationId))
      .where("credential.audience", "=", ACTIVE_SPEECH_AUDIENCE)
      .where("credential.scope", "=", ACTIVE_SPEECH_SCOPE);
    const row = await query.forUpdate().executeTakeFirst();
    if (!row) return undefined;
    await trx.selectFrom("ai_funded_runtime_balances").select("machine_id").where("machine_id", "=", row.machine_id).forUpdate().executeTakeFirstOrThrow();
    if (activeAt !== undefined) {
      const credential = await trx.selectFrom("ai_runtime_credentials").select(["revoked_at", "expires_at"])
        .where("token_id", "=", row.token_id).executeTakeFirstOrThrow();
      if (credential.revoked_at !== null || credential.expires_at <= now().toISOString()) return undefined;
    }
    return row;
  }

  async function start(trx: Transaction<PlatformDatabase>, reservationId: string): Promise<void> {
    const row = await speechReservation(trx, reservationId, "active");
    const checked = now();
    const checkedAt = checked.toISOString();
    if (!row) throw new SpeechFundingError("unavailable");
    if (row.execution_admission_release !== null || row.charge_waiver !== null || row.customer_charge_release !== null) throw new SpeechFundingError("unavailable");
    const capture = readSpeechAuthorization(row);
    if (row.status === "in_flight") return;
    if (row.status !== "reserved" || Date.parse(row.expires_at) <= checked.getTime()) {
      throw new SpeechFundingError("unavailable");
    }
    const updated = await trx.updateTable("ai_funded_usage_reservations").set({
      status: "in_flight",
      started_at: checkedAt,
      expires_at: new Date(checked.getTime() + inFlightTtlMs).toISOString(),
      start_response: JSON.stringify({ capability: ACTIVE_SPEECH_SCOPE, startedAt: checkedAt, ...(capture.postpaid ? { billingPolicy: "postpaid" } : {}) }),
    }).where("reservation_id", "=", row.reservation_id).where("status", "=", "reserved")
      .returning("reservation_id").executeTakeFirst();
    if (!updated) throw new SpeechFundingError("unavailable");
  }

  async function settle(
    trx: Transaction<PlatformDatabase>,
    reservationId: string,
    input: { mode: "exact"; actualCostMicrousd: number } | { mode: "conservative" },
  ): Promise<void> {
    const row = await speechReservation(trx, reservationId);
    if (!row) throw new SpeechFundingError("unavailable");
    if (row.execution_admission_release !== null && row.customer_charge_release === null) readFundedRecoveryAudit(row);
    const capture = readSpeechAuthorization(row);
    if (!capture.postpaid && row.customer_charge_release === null && row.status === "settled") {
      const replayActual = input.mode === "exact" ? MoneySchema.parse(input.actualCostMicrousd) : exactInteger(row.reserved_microusd);
      if (row.actual_microusd === null || exactInteger(row.actual_microusd) !== replayActual || row.finalization_mode !== input.mode) {
        throw new SpeechFundingError("unavailable");
      }
      return;
    }
    if (capture.postpaid || row.customer_charge_release !== null || input.mode === "conservative"
      || row.expires_at <= now().toISOString()) {
      await settlePostpaidSpeech(trx, row, input, now().toISOString(), sourcePolicy);
      return;
    }
    const reserved = exactInteger(row.reserved_microusd);
    const actual = input.mode === "exact" ? MoneySchema.parse(input.actualCostMicrousd) : reserved;
    if (actual > reserved) throw new SpeechFundingError("unavailable");
    if (row.status === "settled") {
      if (exactInteger(row.actual_microusd) !== actual || row.finalization_mode !== input.mode) {
        throw new SpeechFundingError("unavailable");
      }
      return;
    }
    if (row.status !== "in_flight") throw new SpeechFundingError("unavailable");
    const checkedAt = now().toISOString();
    const speechMonthly = isSpeechMonthlyAuthorization(row.authorization_response);
    const identity = { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot };
    await reconcileExpiredPromotionalCredit(trx, identity, checkedAt);
    const balance = await trx.selectFrom("ai_funded_runtime_balances").selectAll()
      .where("machine_id", "=", row.machine_id).forUpdate().executeTakeFirstOrThrow();
    const debit = await reservationDebitSplit(trx, identity, row, actual, balance);
    await debitAttributedPromotionalGrants(trx, row.reservation_id, debit.promotionalDebit, checkedAt);
    await recordUsageFunding(
      trx,
      row,
      actual,
      debit.promotionalDebit,
      debit.addonDebit,
      checkedAt,
      false,
      !speechMonthly,
    );
    if (speechMonthly) {
      const allowance = await trx.updateTable("speech_runtime_allowances").set({
        period_reserved_microusd: sql<number>`CASE WHEN period_start = ${row.period_start}
          THEN period_reserved_microusd - ${reserved} ELSE period_reserved_microusd END`,
        period_spent_microusd: sql<number>`CASE WHEN period_start = ${row.period_start}
          THEN period_spent_microusd + ${actual} ELSE period_spent_microusd END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", row.machine_id)
        .where("owner_id", "=", row.owner_id)
        .where("runtime_slot", "=", row.runtime_slot)
        .where((eb) => eb.or([
          eb("period_start", "<>", row.period_start),
          eb("period_reserved_microusd", ">=", reserved),
        ]))
        .returning("machine_id").executeTakeFirst();
      if (!allowance) throw new SpeechFundingError("unavailable");
    }
    await trx.updateTable("ai_funded_usage_reservations").set({
      status: "settled",
      actual_microusd: actual,
      finalization_mode: input.mode,
      settlement_response: JSON.stringify({ capability: ACTIVE_SPEECH_SCOPE, actualCostMicrousd: actual }),
      settled_at: checkedAt,
    }).where("reservation_id", "=", row.reservation_id).where("status", "=", "in_flight")
      .executeTakeFirstOrThrow();
  }

  async function release(trx: Transaction<PlatformDatabase>, reservationId: string): Promise<void> {
    const row = await speechReservation(trx, reservationId);
    if (!row) throw new SpeechFundingError("unavailable");
    if (row.status === "released") return;
    if (row.status !== "reserved") throw new SpeechFundingError("unavailable");
    const checkedAt = now().toISOString();
    const reserved = exactInteger(row.reserved_microusd);
    const capture = readSpeechAuthorization(row);
    const speechMonthly = capture.monthly;
    if (capture.postpaid) {
      await releaseSpeechAllowance(trx, row, capture, checkedAt);
      await trx.updateTable("ai_funded_usage_reservations").set({ status: "released", release_reason: "cancelled",
        release_response: JSON.stringify({ capability: ACTIVE_SPEECH_SCOPE, billingPolicy: "postpaid", releasedMicrousd: 0 }), released_at: checkedAt })
        .where("reservation_id", "=", row.reservation_id).where("status", "=", "reserved").returning("reservation_id").executeTakeFirstOrThrow();
      return;
    }
    const balance = await trx.updateTable("ai_funded_runtime_balances").set({
      reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
      ...(!speechMonthly ? {
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${row.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
      } : {}),
      updated_at: checkedAt,
    }).where("machine_id", "=", row.machine_id)
      .where("owner_id", "=", row.owner_id)
      .where("runtime_slot", "=", row.runtime_slot)
      .where(sql<boolean>`reserved_microusd >= ${reserved}`)
      .returning("machine_id").executeTakeFirst();
    if (!balance) throw new SpeechFundingError("unavailable");
    if (speechMonthly) {
      const allowance = await trx.updateTable("speech_runtime_allowances").set({
        period_reserved_microusd: sql<number>`CASE WHEN period_start = ${row.period_start}
          THEN period_reserved_microusd - ${reserved} ELSE period_reserved_microusd END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", row.machine_id)
        .where("owner_id", "=", row.owner_id)
        .where("runtime_slot", "=", row.runtime_slot)
        .where((eb) => eb.or([
          eb("period_start", "<>", row.period_start),
          eb("period_reserved_microusd", ">=", reserved),
        ]))
        .returning("machine_id").executeTakeFirst();
      if (!allowance) throw new SpeechFundingError("unavailable");
    }
    await trx.updateTable("ai_funded_usage_reservations").set({
      status: "released",
      release_reason: "cancelled",
      release_response: JSON.stringify({ capability: ACTIVE_SPEECH_SCOPE, releasedMicrousd: reserved }),
      released_at: checkedAt,
    }).where("reservation_id", "=", row.reservation_id).where("status", "=", "reserved")
      .executeTakeFirstOrThrow();
  }

  return { reserve, start, settle, release };
}
