/**
 * Funded AI authorization: the single owner-wide admission point before a
 * reservation. Under an owner advisory lock it checks the credential, runtime
 * policy, and balance ceilings, applies interactive priority, and reserves the
 * hold with its funding sources, all in one transaction. Extracted from the
 * metering repository so that file stays under the large-file limit.
 */
import { createHash } from "node:crypto";
import {
  FUNDED_AI_AUDIENCE,
  FUNDED_AI_SCOPE,
  FundedAiAuthorizationRequestSchema,
  FundedAiAuthorizationResponseSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiPriorityReason,
} from "@matrix-os/contracts";
import { sql } from "kysely";
import type { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import {
  FUNDED_TOKEN_PATTERN,
  FundedReferenceSchema,
  exactInteger,
  fundingSummary,
  hashesEqual,
  intersectModels,
  parseModels,
  utcMonthStart,
} from "./ai-funded-metering-helpers.js";
import { evaluateFundedPriority, findConflictingActiveReservation, type FundedBillingMode } from "./ai-funded-priority-claims.js";
import { reconcileExpiredPromotionalCredit, reserveFundingSources } from "./ai-funded-reservation-sources.js";

type AuthorizeOutcome =
  | { kind: "authorized"; response: FundedAiAuthorizationResponse }
  | { kind: "rejected"; reason: FundedAiPriorityReason };

export interface FundedAuthorizeDependencies {
  db: PlatformDB;
  now: () => Date;
  hashCredential(credential: string): string;
  reservationIdFactory(): string;
  reservationTtlMs: number;
  policyFreshnessMs: number;
}

export function createFundedAuthorize(deps: FundedAuthorizeDependencies) {
  return async function authorize(input: z.input<typeof FundedAiAuthorizationRequestSchema>): Promise<FundedAiAuthorizationResponse> {
    const request = FundedAiAuthorizationRequestSchema.parse(input);
    const tokenMatch = FUNDED_TOKEN_PATTERN.exec(request.credential);
    if (!tokenMatch) throw new AiFundedPolicyError("unauthorized");
    const checked = deps.now();
    const checkedAt = checked.toISOString();
    const periodStart = utcMonthStart(checked);
    const payloadHash = createHash("sha256").update(JSON.stringify({
      tokenId: tokenMatch[1], requestId: request.requestId,
      modelId: request.modelId, maxCostMicrousd: request.maxCostMicrousd,
      ...(request.billingMode ? { billingMode: request.billingMode } : {}),
      ...(request.jevPricingVersion ? { jevPricingVersion: request.jevPricingVersion } : {}),
    })).digest("hex");
    await deps.db.ready;
    const outcome = await deps.db.transaction(async (trx): Promise<AuthorizeOutcome> => {
      const credential = await trx.executor.selectFrom("ai_runtime_credentials")
        .selectAll().where("token_id", "=", tokenMatch[1]).executeTakeFirst();
      if (!credential || !hashesEqual(credential.token_hash, deps.hashCredential(request.credential))
        || credential.revoked_at !== null || Date.parse(credential.expires_at) <= checked.getTime()
        || credential.audience !== FUNDED_AI_AUDIENCE || credential.scope !== FUNDED_AI_SCOPE) {
        throw new AiFundedPolicyError("unauthorized");
      }
      // Serialize admission across every runtime/replica for this owner. The
      // namespaced transaction lock is acquired before runtime and balance locks.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${credential.owner_id}`}, 0))`.execute(trx.executor);
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
        return { kind: "authorized", response: FundedAiAuthorizationResponseSchema.parse(JSON.parse(existing.authorization_response)) };
      }

      const billingMode: FundedBillingMode = request.billingMode === "usage" ? "usage" : "hold";
      const monthlyBudget = exactInteger(runtime.monthly_budget_microusd);
      const balance = await trx.executor.selectFrom("ai_funded_runtime_balances")
        .selectAll().where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
      // Upper bounds ignore active holds, which may still be released. A request that
      // cannot fit even then fails now and never takes a priority place.
      const creditCeiling = exactInteger(balance.credit_balance_microusd) - exactInteger(balance.funding_shortfall_microusd);
      const budgetCeiling = monthlyBudget - exactInteger(balance.month_spent_microusd);
      const ceilingHold = billingMode === "usage" ? 1 : request.maxCostMicrousd;
      if (ceilingHold > budgetCeiling) throw new AiFundedPolicyError("budget_exceeded");
      if (ceilingHold > creditCeiling) throw new AiFundedPolicyError("insufficient_credit");

      const priority = await evaluateFundedPriority(trx.executor, {
        ownerId: credential.owner_id,
        machineId: credential.machine_id,
        runtimeSlot: credential.runtime_slot,
        claimKey: request.claimKey ?? "",
        requestClass: credential.request_class,
        billingMode,
        checked,
      });
      // A priority rejection may have written a claim; return it so the claim commits.
      if (priority.kind === "rejected") return { kind: "rejected", reason: priority.reason };
      if (await findConflictingActiveReservation(trx.executor, credential.owner_id, billingMode)) {
        // A capacity refusal before any reservation: the reason tells callers it is safe to retry.
        throw new AiFundedPolicyError("rate_limited", "slot_busy");
      }
      let holdMicrousd = request.maxCostMicrousd;
      if (billingMode === "usage") {
        const credit = exactInteger(balance.credit_balance_microusd) - exactInteger(balance.reserved_microusd)
          - exactInteger(balance.funding_shortfall_microusd);
        const budget = monthlyBudget - exactInteger(balance.month_spent_microusd)
          - exactInteger(balance.month_reserved_microusd);
        if (credit <= 0) throw new AiFundedPolicyError("insufficient_credit");
        if (budget <= 0) throw new AiFundedPolicyError("budget_exceeded");
        holdMicrousd = Math.min(holdMicrousd, credit, budget);
      }
      const reserved = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        reserved_microusd: sql<number>`reserved_microusd + ${holdMicrousd}`,
        month_reserved_microusd: sql<number>`month_reserved_microusd + ${holdMicrousd}`,
        updated_at: checkedAt,
      }).where("machine_id", "=", identity.machineId)
        .where(sql<boolean>`reserved_microusd <= ${Number.MAX_SAFE_INTEGER - holdMicrousd}`)
        .where(sql<boolean>`credit_balance_microusd - reserved_microusd - funding_shortfall_microusd >= ${holdMicrousd}`)
        .where(sql<boolean>`${monthlyBudget} - month_spent_microusd - month_reserved_microusd >= ${holdMicrousd}`)
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
        holdMicrousd,
        reserved,
        checkedAt,
      );

      const reservationId = FundedReferenceSchema.parse(deps.reservationIdFactory());
      const expiresAt = new Date(checked.getTime() + deps.reservationTtlMs).toISOString();
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
          staleAfter: new Date(checked.getTime() + deps.policyFreshnessMs).toISOString(),
        },
        funding: fundingSummary(reserved, monthlyBudget, checkedAt),
        reservation: {
          reservationId,
          requestId: request.requestId,
          modelId: request.modelId,
          reservedMicrousd: holdMicrousd,
          ...(request.billingMode ? { billingMode: request.billingMode, maxCostMicrousd: request.maxCostMicrousd } : {}),
          ...(request.jevPricingVersion ? { jevPricingVersion: request.jevPricingVersion } : {}),
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
        manual_review_evidence_ref: null,
        manual_review_actor: null,
        manual_reviewed_at: null,
        token_id: credential.token_id,
        ...{
          owner_id: identity.ownerId,
          machine_id: identity.machineId,
          runtime_slot: identity.runtimeSlot,
        },
        model_id: request.modelId,
        reserved_microusd: holdMicrousd,
        promotional_reserved_microusd: fundingSources.promotionalReservedMicrousd,
        addon_reserved_microusd: fundingSources.addonReservedMicrousd,
        actual_microusd: null,
        resolved_model: null,
        pricing_version: null,
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
      return { kind: "authorized", response };
    }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "23505"
        && "constraint" in error && error.constraint === "idx_ai_funded_usage_active_owner") {
        throw new AiFundedPolicyError("rate_limited", "slot_busy");
      }
      throw error;
    });
    if (outcome.kind === "rejected") throw new AiFundedPolicyError("rate_limited", outcome.reason);
    return outcome.response;
  }
}
