/**
 * Funded-AI metering reservations operations.
 *
 * Extracted from ./ai-funded-metering-repository.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import { AiFundedPolicyError } from '../ai-funded-policy-errors.js';
import {
  debitAttributedPromotionalGrants,
  debitPromotionalGrants,
  reconcileExpiredPromotionalCredit,
  reservationDebitSplit,
  reserveFundingSources,
} from '../ai-funded-reservation-sources.js';
import {
  ReferenceSchema,
  TOKEN_PATTERN,
  exactInteger,
  fundingSummary,
  hashesEqual,
  intersectModels,
  parseModels,
  recordUsageFunding,
  utcMonthStart,
} from './codecs.js';
import {
  FUNDED_AI_AUDIENCE,
  FUNDED_AI_SCOPE,
  FundedAiAuthorizationRequestSchema,
  FundedAiAuthorizationResponseSchema,
  FundedAiFundingSummarySchema,
  FundedAiFinalizationRequestSchema,
  FundedAiFinalizationResponseSchema,
  FundedAiPolicyCheckRequestSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiReleaseRequestSchema,
  FundedAiReleaseResponseSchema,
  FundedAiSettlementRequestSchema,
  FundedAiSettlementResponseSchema,
  FundedAiStartRequestSchema,
  FundedAiStartResponseSchema,
  IsoTimestampSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiFundingSummary,
  type FundedAiFinalizationResponse,
  type FundedAiPolicyCheckResponse,
  type FundedAiReleaseResponse,
  type FundedAiSettlementResponse,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import type { AiFundedMeteringRepositoryOptions } from '../ai-funded-metering-repository.js';

export function createMeteringReservations(options: AiFundedMeteringRepositoryOptions) {
  const reservationIdFactory = options.reservationIdFactory ?? randomUUID;
  const hashCredential = (credential: string) => createHmac("sha256", options.credentialHashSecret)
    .update(credential).digest("hex");
  async function authorize(input: z.input<typeof FundedAiAuthorizationRequestSchema>): Promise<FundedAiAuthorizationResponse> {
    const request = FundedAiAuthorizationRequestSchema.parse(input);
    const tokenMatch = TOKEN_PATTERN.exec(request.credential);
    if (!tokenMatch) throw new AiFundedPolicyError("unauthorized");
    const checked = options.now();
    const checkedAt = checked.toISOString();
    const periodStart = utcMonthStart(checked);
    const payloadHash = createHash("sha256").update(JSON.stringify({
      tokenId: tokenMatch[1], requestId: request.requestId,
      modelId: request.modelId, maxCostMicrousd: request.maxCostMicrousd,
    })).digest("hex");
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const credential = await trx.executor.selectFrom("ai_runtime_credentials")
        .selectAll().where("token_id", "=", tokenMatch[1]).executeTakeFirst();
      if (!credential || !hashesEqual(credential.token_hash, hashCredential(request.credential))
        || credential.revoked_at !== null || Date.parse(credential.expires_at) <= checked.getTime()
        || credential.audience !== FUNDED_AI_AUDIENCE || credential.scope !== FUNDED_AI_SCOPE) {
        throw new AiFundedPolicyError("unauthorized");
      }
      const runtime = await trx.executor.selectFrom("ai_funded_runtime_policies")
        .selectAll().where("machine_id", "=", credential.machine_id).forUpdate().executeTakeFirst();
      const machine = await trx.executor.selectFrom("user_machines").select([
        "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
      ]).where("machine_id", "=", credential.machine_id).executeTakeFirst();
      const global = await trx.executor.selectFrom("ai_funded_global_policy")
        .selectAll().where("policy_id", "=", "default").executeTakeFirstOrThrow();
      const restriction = await trx.executor.selectFrom("ai_funded_credit_restrictions")
        .select(["debt_microusd", "frozen"]).where("machine_id", "=", credential.machine_id)
        .forUpdate().executeTakeFirst();
      if (!runtime || !machine || machine.clerk_user_id !== credential.owner_id
        || machine.runtime_slot !== credential.runtime_slot || machine.status !== "running"
        || machine.activation_state !== "authorized" || machine.deleted_at !== null
        || runtime.owner_id !== credential.owner_id || runtime.runtime_slot !== credential.runtime_slot) {
        throw new AiFundedPolicyError("unauthorized");
      }
      if (!global.enabled || !runtime.enabled || restriction?.frozen === true
        || exactInteger(restriction?.debt_microusd ?? 0) > 0
        || (runtime.expires_at !== null && Date.parse(runtime.expires_at) <= checked.getTime())) {
        throw new AiFundedPolicyError("access_disabled");
      }
      const allowedModelIds = intersectModels(parseModels(global.allowed_model_ids), parseModels(runtime.allowed_model_ids));
      if (!allowedModelIds.includes(request.modelId)) throw new AiFundedPolicyError("model_not_allowed");

      const identity = {
        ownerId: credential.owner_id,
        machineId: credential.machine_id,
        runtimeSlot: credential.runtime_slot,
      };
      await reconcileExpiredPromotionalCredit(trx.executor, identity, checkedAt);
      const reset = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        month_period_start: periodStart,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${periodStart} THEN month_spent_microusd ELSE 0 END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${periodStart} THEN month_reserved_microusd ELSE 0 END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", identity.machineId).where("owner_id", "=", identity.ownerId)
        .where("runtime_slot", "=", identity.runtimeSlot).returning("machine_id").executeTakeFirst();
      if (!reset) throw new AiFundedPolicyError("access_disabled");

      const existing = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .select(["payload_hash", "authorization_response"])
        .where("token_id", "=", credential.token_id).where("request_id", "=", request.requestId)
        .executeTakeFirst();
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new AiFundedPolicyError("idempotency_conflict");
        return FundedAiAuthorizationResponseSchema.parse(JSON.parse(existing.authorization_response));
      }

      const monthlyBudget = exactInteger(runtime.monthly_budget_microusd);
      const reserved = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        reserved_microusd: sql<number>`reserved_microusd + ${request.maxCostMicrousd}`,
        month_reserved_microusd: sql<number>`month_reserved_microusd + ${request.maxCostMicrousd}`,
        updated_at: checkedAt,
      }).where("machine_id", "=", identity.machineId)
        .where(sql<boolean>`reserved_microusd <= ${Number.MAX_SAFE_INTEGER - request.maxCostMicrousd}`)
        .where(sql<boolean>`credit_balance_microusd - reserved_microusd - funding_shortfall_microusd >= ${request.maxCostMicrousd}`)
        .where(sql<boolean>`${monthlyBudget} - month_spent_microusd - month_reserved_microusd >= ${request.maxCostMicrousd}`)
        .returning([
          "credit_balance_microusd", "promotional_balance_microusd", "addon_balance_microusd",
          "reserved_microusd", "funding_shortfall_microusd", "month_period_start",
          "month_spent_microusd", "month_reserved_microusd",
        ])
        .executeTakeFirst();
      if (!reserved) {
        const balance = await trx.executor.selectFrom("ai_funded_runtime_balances")
          .selectAll().where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();
        const availableBudget = monthlyBudget - exactInteger(balance.month_spent_microusd)
          - exactInteger(balance.month_reserved_microusd);
        if (request.maxCostMicrousd > availableBudget) throw new AiFundedPolicyError("budget_exceeded");
        throw new AiFundedPolicyError("insufficient_credit");
      }
      const remainingBalance = exactInteger(reserved.credit_balance_microusd)
        - exactInteger(reserved.reserved_microusd)
        - exactInteger(reserved.funding_shortfall_microusd);
      const remainingBudget = monthlyBudget - exactInteger(reserved.month_spent_microusd)
        - exactInteger(reserved.month_reserved_microusd);
      const fundingSources = await reserveFundingSources(
        trx.executor,
        identity,
        request.maxCostMicrousd,
        reserved,
        checkedAt,
      );

      const reservationId = ReferenceSchema.parse(reservationIdFactory());
      const expiresAt = new Date(checked.getTime() + options.reservationTtlMs).toISOString();
      const response = FundedAiAuthorizationResponseSchema.parse({
        contractVersion: 1,
        authorized: true,
        identity: {
          tokenId: credential.token_id,
          ...identity,
          audience: FUNDED_AI_AUDIENCE,
          scope: FUNDED_AI_SCOPE,
          expiresAt: credential.expires_at,
        },
        policy: {
          enabled: true,
          globalRevision: global.revision,
          runtimeRevision: runtime.revision,
          allowedModelIds,
          monthlyBudgetMicrousd: monthlyBudget,
          checkedAt,
          staleAfter: new Date(checked.getTime() + options.policyFreshnessMs).toISOString(),
        },
        funding: fundingSummary(reserved, monthlyBudget, checkedAt),
        reservation: {
          reservationId,
          requestId: request.requestId,
          modelId: request.modelId,
          reservedMicrousd: request.maxCostMicrousd,
          remainingBalanceMicrousd: remainingBalance,
          remainingBudgetMicrousd: remainingBudget,
          periodStart,
          expiresAt,
          status: "reserved",
        },
      });
      await trx.executor.insertInto("ai_funded_usage_reservations").values({
        reservation_id: reservationId,
        request_id: request.requestId,
        payload_hash: payloadHash,
        authorization_response: JSON.stringify(response),
        settlement_response: null,
        finalization_mode: null,
        start_response: null,
        release_response: null,
        release_reason: null,
        token_id: credential.token_id,
        ...{
          owner_id: identity.ownerId,
          machine_id: identity.machineId,
          runtime_slot: identity.runtimeSlot,
        },
        model_id: request.modelId,
        reserved_microusd: request.maxCostMicrousd,
        promotional_reserved_microusd: fundingSources.promotionalReservedMicrousd,
        addon_reserved_microusd: fundingSources.addonReservedMicrousd,
        actual_microusd: null,
        period_start: periodStart,
        status: "reserved",
        created_at: checkedAt,
        started_at: null,
        expires_at: expiresAt,
        settled_at: null,
        released_at: null,
      }).execute();
      if (fundingSources.grantAllocations.length > 0) {
        await trx.executor.insertInto("ai_funded_reservation_promotional_allocations").values(
          fundingSources.grantAllocations.map((allocation) => ({
            reservation_id: reservationId,
            grant_entry_id: allocation.grantEntryId,
            amount_microusd: allocation.amountMicrousd,
            created_at: checkedAt,
          })),
        ).execute();
      }
      return response;
    });
  }


  async function startReservation(
    input: z.input<typeof FundedAiStartRequestSchema>,
  ): Promise<FundedAiStartResponse> {
    const request = FundedAiStartRequestSchema.parse(input);
    const checked = options.now();
    const checkedAt = checked.toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const reservation = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .selectAll().where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).forUpdate().executeTakeFirst();
      if (!reservation) throw new AiFundedPolicyError("unauthorized");
      if (reservation.status === "in_flight") {
        if (reservation.start_response === null) throw new Error("In-flight reservation is missing its response");
        return FundedAiStartResponseSchema.parse(JSON.parse(reservation.start_response));
      }
      if (reservation.status !== "reserved") throw new AiFundedPolicyError("reservation_closed");
      if (Date.parse(reservation.expires_at) <= checked.getTime()) {
        throw new AiFundedPolicyError("reservation_expired");
      }
      const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ status: "starting" }).where("reservation_id", "=", reservation.reservation_id)
        .where("status", "=", "reserved").returning("reservation_id").executeTakeFirst();
      if (!claimed) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["status", "start_response"])
          .where("reservation_id", "=", reservation.reservation_id).executeTakeFirstOrThrow();
        if (latest.status === "in_flight" && latest.start_response !== null) {
          return FundedAiStartResponseSchema.parse(JSON.parse(latest.start_response));
        }
        if (latest.status === "starting") throw new AiFundedPolicyError("rate_limited");
        throw new AiFundedPolicyError("reservation_closed");
      }
      const expiresAt = new Date(checked.getTime() + options.inFlightTtlMs).toISOString();
      const response = FundedAiStartResponseSchema.parse({
        contractVersion: 1,
        reservationId: reservation.reservation_id,
        requestId: reservation.request_id,
        tokenId: reservation.token_id,
        startedAt: checkedAt,
        expiresAt,
        status: "in_flight",
      });
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
        status: "in_flight",
        started_at: checkedAt,
        expires_at: expiresAt,
        start_response: JSON.stringify(response),
      }).where("reservation_id", "=", reservation.reservation_id).where("status", "=", "starting")
        .returning("reservation_id").executeTakeFirst();
      if (!updated) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["status", "start_response"]).where("reservation_id", "=", reservation.reservation_id)
          .executeTakeFirstOrThrow();
        if (latest.status === "in_flight" && latest.start_response !== null) {
          return FundedAiStartResponseSchema.parse(JSON.parse(latest.start_response));
        }
        throw new AiFundedPolicyError("reservation_closed");
      }
      return response;
    });
  }


  async function settleReservation(
    input: z.input<typeof FundedAiSettlementRequestSchema>,
  ): Promise<FundedAiSettlementResponse> {
    const request = FundedAiSettlementRequestSchema.parse(input);
    return (await settleReservationInternal(request, "exact")).response;
  }

  async function settleReservationInternal(request: {
    reservationId: string;
    tokenId: string;
    actualCostMicrousd: number | null;
  }, finalizationMode: "exact" | "conservative"): Promise<{
    response: FundedAiSettlementResponse;
    finalizationMode: "exact" | "conservative";
  }> {
    const checked = options.now();
    const checkedAt = checked.toISOString();
    await options.db.ready;
    const result = await options.db.transaction(async (trx) => {
      const locator = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .select(["machine_id"]).where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).executeTakeFirst();
      if (!locator) throw new AiFundedPolicyError("unauthorized");
      const runtime = await trx.executor.selectFrom("ai_funded_runtime_policies")
        .select(["monthly_budget_microusd"]).where("machine_id", "=", locator.machine_id)
        .executeTakeFirstOrThrow();
      const reservation = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .selectAll().where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).forUpdate().executeTakeFirstOrThrow();
      const reserved = exactInteger(reservation.reserved_microusd);
      const actualCostMicrousd = request.actualCostMicrousd ?? reserved;
      if (reservation.status === "settled") {
        if (exactInteger(reservation.actual_microusd) !== actualCostMicrousd) {
          throw new AiFundedPolicyError("idempotency_conflict");
        }
        if (reservation.settlement_response === null) throw new Error("Settled reservation is missing its response");
        return {
          response: FundedAiSettlementResponseSchema.parse(JSON.parse(reservation.settlement_response)),
          finalizationMode: reservation.finalization_mode === "conservative" ? "conservative" : "exact",
        } as const;
      }
      if (reservation.status !== "in_flight" && reservation.status !== "expired") {
        throw new AiFundedPolicyError("reservation_closed");
      }
      if (reservation.status === "expired" || Date.parse(reservation.expires_at) <= checked.getTime()) {
        throw new AiFundedPolicyError("reservation_expired");
      }
      if (actualCostMicrousd > reserved) throw new AiFundedPolicyError("over_settlement");
      const reservationIdentity = {
        ownerId: reservation.owner_id,
        machineId: reservation.machine_id,
        runtimeSlot: reservation.runtime_slot,
      };
      // Reconcile while the locked reservation is still active so explicit
      // per-grant allocations remain protected. Legacy NULL attribution has no
      // such protection, making expired backing unavailable before debit split.
      await reconcileExpiredPromotionalCredit(
        trx.executor,
        reservationIdentity,
        checkedAt,
      );
      const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ status: "settling" }).where("reservation_id", "=", reservation.reservation_id)
        .where("status", "=", "in_flight").returning("reservation_id").executeTakeFirst();
      if (!claimed) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
          .where("reservation_id", "=", reservation.reservation_id).executeTakeFirstOrThrow();
        if (latest.status === "settled" && exactInteger(latest.actual_microusd) === actualCostMicrousd
          && latest.settlement_response !== null) {
          return {
            response: FundedAiSettlementResponseSchema.parse(JSON.parse(latest.settlement_response)),
            finalizationMode: latest.finalization_mode === "conservative" ? "conservative" : "exact",
          } as const;
        }
        if (latest.status === "settled") throw new AiFundedPolicyError("idempotency_conflict");
        if (latest.status === "settling") throw new AiFundedPolicyError("rate_limited");
        throw new AiFundedPolicyError("reservation_closed");
      }
      const currentPeriod = utcMonthStart(checked);
      const currentBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        month_period_start: currentPeriod,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_spent_microusd ELSE 0 END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_reserved_microusd ELSE 0 END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", locator.machine_id).returningAll().executeTakeFirstOrThrow();
      const { promotionalDebit, addonDebit, attributed } = await reservationDebitSplit(
        trx.executor,
        reservationIdentity,
        reservation,
        actualCostMicrousd,
        currentBalance,
      );
      let appliedPromotionalDebit = promotionalDebit;
      if (attributed) {
        await debitAttributedPromotionalGrants(
          trx.executor,
          reservation.reservation_id,
          promotionalDebit,
          checkedAt,
        );
      } else {
        appliedPromotionalDebit = await debitPromotionalGrants(
          trx.executor,
          reservationIdentity,
          promotionalDebit,
          checkedAt,
        );
      }
      const chargedMicrousd = appliedPromotionalDebit + addonDebit;
      if (attributed && chargedMicrousd !== actualCostMicrousd) {
        throw new Error("Funded AI attributed reservation debit invariant violated");
      }
      // A migrated reservation may lack source attribution. Charge every live,
      // unprotected source that can be proven and persist the remainder as a
      // contra-credit shortfall so full provider usage is never made spendable.
      await recordUsageFunding(
        trx.executor,
        reservation,
        actualCostMicrousd,
        appliedPromotionalDebit,
        addonDebit,
        checkedAt,
      );
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
        status: "settled",
        actual_microusd: actualCostMicrousd,
        settled_at: checkedAt,
        finalization_mode: finalizationMode,
      }).where("reservation_id", "=", reservation.reservation_id).where("status", "=", "settling")
        .returningAll().executeTakeFirstOrThrow();
      const monthlyBudget = exactInteger(runtime.monthly_budget_microusd);
      const balance = await reconcileExpiredPromotionalCredit(trx.executor, {
        ownerId: reservation.owner_id,
        machineId: reservation.machine_id,
        runtimeSlot: reservation.runtime_slot,
      }, checkedAt);
      const funding = fundingSummary(balance, monthlyBudget, checkedAt);
      const response = FundedAiSettlementResponseSchema.parse({
        contractVersion: 1,
        reservationId: updated.reservation_id,
        requestId: updated.request_id,
        tokenId: updated.token_id,
        actualCostMicrousd,
        releasedMicrousd: reserved - actualCostMicrousd,
        remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
        remainingBudgetMicrousd: funding.remainingBudgetMicrousd,
        funding,
        settledAt: checkedAt,
        status: "settled",
      });
      await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ settlement_response: JSON.stringify(response) })
        .where("reservation_id", "=", reservation.reservation_id).execute();
      return { response, finalizationMode } as const;
    });
    return result;
  }


  async function finalizeReservation(
    input: z.input<typeof FundedAiFinalizationRequestSchema>,
  ): Promise<FundedAiFinalizationResponse> {
    const request = FundedAiFinalizationRequestSchema.parse(input);
    const settlement = await settleReservationInternal({
      reservationId: request.reservationId,
      tokenId: request.tokenId,
      actualCostMicrousd: request.mode === "exact" ? request.actualCostMicrousd : null,
    }, request.mode);
    return FundedAiFinalizationResponseSchema.parse({
      ...settlement.response,
      finalizationMode: settlement.finalizationMode,
    });
  }


  async function releaseReservation(
    input: z.input<typeof FundedAiReleaseRequestSchema>,
  ): Promise<FundedAiReleaseResponse> {
    const request = FundedAiReleaseRequestSchema.parse(input);
    const checked = options.now();
    const checkedAt = checked.toISOString();
    const currentPeriod = utcMonthStart(checked);
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const locator = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .select("machine_id").where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).executeTakeFirst();
      if (!locator) throw new AiFundedPolicyError("unauthorized");
      const runtime = await trx.executor.selectFrom("ai_funded_runtime_policies")
        .select("monthly_budget_microusd").where("machine_id", "=", locator.machine_id)
        .executeTakeFirstOrThrow();
      const reservation = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .selectAll().where("reservation_id", "=", request.reservationId)
        .where("token_id", "=", request.tokenId).forUpdate().executeTakeFirstOrThrow();
      if (reservation.status === "released") {
        if (reservation.release_reason !== request.reason || reservation.release_response === null) {
          throw new AiFundedPolicyError("idempotency_conflict");
        }
        return FundedAiReleaseResponseSchema.parse(JSON.parse(reservation.release_response));
      }
      if (reservation.status !== "reserved") throw new AiFundedPolicyError("reservation_closed");
      if (Date.parse(reservation.expires_at) <= checked.getTime()) {
        throw new AiFundedPolicyError("reservation_expired");
      }
      const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ status: "releasing" }).where("reservation_id", "=", reservation.reservation_id)
        .where("status", "=", "reserved").returning("reservation_id").executeTakeFirst();
      if (!claimed) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations")
          .select(["status", "release_reason", "release_response"])
          .where("reservation_id", "=", reservation.reservation_id).executeTakeFirstOrThrow();
        if (latest.status === "released" && latest.release_reason === request.reason
          && latest.release_response !== null) {
          return FundedAiReleaseResponseSchema.parse(JSON.parse(latest.release_response));
        }
        if (latest.status === "releasing") throw new AiFundedPolicyError("rate_limited");
        throw new AiFundedPolicyError("reservation_closed");
      }
      const reset = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        month_period_start: currentPeriod,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_spent_microusd ELSE 0 END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_reserved_microusd ELSE 0 END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", locator.machine_id).returning("machine_id").executeTakeFirst();
      if (!reset) throw new AiFundedPolicyError("access_disabled");
      const reserved = exactInteger(reservation.reserved_microusd);
      const releasedBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", reservation.machine_id)
        .where(sql<boolean>`reserved_microusd >= ${reserved}`).returningAll().executeTakeFirst();
      if (!releasedBalance) throw new Error("Funded AI balance invariant violated");
      const balance = await reconcileExpiredPromotionalCredit(trx.executor, {
        ownerId: reservation.owner_id,
        machineId: reservation.machine_id,
        runtimeSlot: reservation.runtime_slot,
      }, checkedAt);
      const funding = fundingSummary(balance, exactInteger(runtime.monthly_budget_microusd), checkedAt);
      const response = FundedAiReleaseResponseSchema.parse({
        contractVersion: 1,
        reservationId: reservation.reservation_id,
        requestId: reservation.request_id,
        tokenId: reservation.token_id,
        releasedMicrousd: reserved,
        releasedAt: checkedAt,
        reason: request.reason,
        status: "released",
        funding,
      });
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
        status: "released",
        release_reason: request.reason,
        released_at: checkedAt,
        release_response: JSON.stringify(response),
      }).where("reservation_id", "=", reservation.reservation_id).where("status", "=", "releasing")
        .returning("reservation_id").executeTakeFirst();
      if (!updated) throw new Error("Funded AI reservation invariant violated");
      return response;
    });
  }
  return { authorize, startReservation, settleReservation, finalizeReservation, releaseReservation };
}
