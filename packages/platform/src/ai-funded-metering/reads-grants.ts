/**
 * Funded-AI metering reads-grants operations.
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
  CleanupSchema,
  GrantSchema,
  IdentitySchema,
  MAX_PROMOTIONAL_GRANTS_PER_RUNTIME,
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
  FundedAiPolicyCheckRequestSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiSettlementResponseSchema,
  IsoTimestampSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiFundingSummary,
  type FundedAiPolicyCheckResponse,
} from '@matrix-os/contracts';
import type { AiFundedMeteringRepositoryOptions } from '../ai-funded-metering-repository.js';

export function createMeteringReadsGrants(options: AiFundedMeteringRepositoryOptions) {
  const reservationIdFactory = options.reservationIdFactory ?? randomUUID;
  const hashCredential = (credential: string) => createHmac("sha256", options.credentialHashSecret)
    .update(credential).digest("hex");
  async function getRuntimeFundingSummary(
    identityInput: z.input<typeof IdentitySchema>,
  ) {
    const identity = IdentitySchema.parse(identityInput);
    const checked = options.now();
    const checkedAt = checked.toISOString();
    const currentPeriod = utcMonthStart(checked);
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const machine = await trx.executor.selectFrom("user_machines").select([
        "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
      ]).where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
      const runtime = await trx.executor.selectFrom("ai_funded_runtime_policies")
        .select([
          "owner_id", "runtime_slot", "enabled", "allowed_model_ids", "monthly_budget_microusd",
          "expires_at", "revision",
        ])
        .where("machine_id", "=", identity.machineId).executeTakeFirst();
      const global = await trx.executor.selectFrom("ai_funded_global_policy")
        .selectAll().where("policy_id", "=", "default").executeTakeFirstOrThrow();
      if (!machine || !runtime || machine.clerk_user_id !== identity.ownerId
        || machine.runtime_slot !== identity.runtimeSlot || machine.status !== "running"
        || machine.activation_state !== "authorized" || machine.deleted_at !== null
        || runtime.owner_id !== identity.ownerId || runtime.runtime_slot !== identity.runtimeSlot) {
        throw new AiFundedPolicyError("identity_mismatch");
      }
      await trx.executor.updateTable("ai_funded_runtime_balances").set({
        month_period_start: currentPeriod,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_spent_microusd ELSE 0 END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_reserved_microusd ELSE 0 END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", identity.machineId)
        .where("owner_id", "=", identity.ownerId)
        .where("runtime_slot", "=", identity.runtimeSlot).execute();
      const balance = await reconcileExpiredPromotionalCredit(trx.executor, identity, checkedAt);
      const monthlyBudgetMicrousd = exactInteger(runtime.monthly_budget_microusd);
      const enabled = global.enabled && runtime.enabled
        && (runtime.expires_at === null || Date.parse(runtime.expires_at) > checked.getTime());
      const allowedModelIds = enabled
        ? intersectModels(parseModels(global.allowed_model_ids), parseModels(runtime.allowed_model_ids))
        : [];
      return {
        funding: fundingSummary(balance, monthlyBudgetMicrousd, checkedAt),
        policy: {
          enabled: enabled && allowedModelIds.length > 0,
          globalRevision: global.revision,
          runtimeRevision: runtime.revision,
          allowedModelIds: enabled ? allowedModelIds : [],
          monthlyBudgetMicrousd,
          checkedAt,
          staleAfter: new Date(checked.getTime() + options.policyFreshnessMs).toISOString(),
        },
      };
    });
  }


  async function getFundingSummary(
    identityInput: z.input<typeof IdentitySchema>,
  ): Promise<FundedAiFundingSummary> {
    return (await getRuntimeFundingSummary(identityInput)).funding;
  }


  async function grantCreditInTransaction(
    transaction: PlatformDB,
    input: z.input<typeof GrantSchema>,
    createdAt = options.now().toISOString(),
  ) {
    const grant = GrantSchema.parse(input);
    const at = IsoTimestampSchema.parse(createdAt);
    if (grant.expiresAt !== null && grant.expiresAt <= at) {
      throw new AiFundedPolicyError("access_disabled");
    }
    await transaction.ready;
    const machine = await transaction.executor.selectFrom("user_machines").select([
        "machine_id", "clerk_user_id", "runtime_slot", "deleted_at",
      ]).where("machine_id", "=", grant.identity.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== grant.identity.ownerId
      || machine.runtime_slot !== grant.identity.runtimeSlot || machine.deleted_at !== null) {
      throw new AiFundedPolicyError("identity_mismatch");
    }
    const inserted = await transaction.executor.insertInto("ai_funded_credit_ledger").values({
      entry_id: grant.entryId,
      owner_id: grant.identity.ownerId,
      machine_id: grant.identity.machineId,
      runtime_slot: grant.identity.runtimeSlot,
      kind: grant.kind,
      amount_microusd: grant.amountMicrousd,
      source_reference: grant.sourceReference,
      reservation_id: null,
      period_start: null,
      expires_at: grant.expiresAt,
      created_at: at,
    }).onConflict((conflict) => conflict.column("entry_id").doNothing())
      .returning("entry_id").executeTakeFirst();
    const stored = await transaction.executor.selectFrom("ai_funded_credit_ledger")
      .selectAll().where("entry_id", "=", grant.entryId).executeTakeFirstOrThrow();
    if (stored.owner_id !== grant.identity.ownerId || stored.machine_id !== grant.identity.machineId
      || stored.runtime_slot !== grant.identity.runtimeSlot || stored.kind !== grant.kind
      || exactInteger(stored.amount_microusd) !== grant.amountMicrousd
      || stored.source_reference !== grant.sourceReference || stored.reservation_id !== null
      || stored.expires_at !== grant.expiresAt) {
      throw new AiFundedPolicyError("idempotency_conflict");
    }
    if (inserted) {
      if (grant.kind === "promotional_grant") {
        await reconcileExpiredPromotionalCredit(transaction.executor, grant.identity, at);
        const activeGrantCount = await transaction.executor.selectFrom("ai_funded_promotional_grant_balances")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("owner_id", "=", grant.identity.ownerId)
          .where("machine_id", "=", grant.identity.machineId)
          .where("runtime_slot", "=", grant.identity.runtimeSlot)
          .where("remaining_microusd", ">", 0).executeTakeFirstOrThrow();
        if (exactInteger(activeGrantCount.count) >= MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
          throw new AiFundedPolicyError("rate_limited");
        }
        await transaction.executor.insertInto("ai_funded_promotional_grant_balances").values({
          grant_entry_id: grant.entryId,
          owner_id: grant.identity.ownerId,
          machine_id: grant.identity.machineId,
          runtime_slot: grant.identity.runtimeSlot,
          remaining_microusd: grant.amountMicrousd,
          expires_at: grant.expiresAt,
          created_at: at,
          updated_at: at,
          revision: 0,
        }).execute();
      }
      const bucketUpdate = grant.kind === "promotional_grant"
        ? { promotional_balance_microusd: sql<number>`promotional_balance_microusd + ${grant.amountMicrousd}` }
        : { addon_balance_microusd: sql<number>`addon_balance_microusd + ${grant.amountMicrousd}` };
      const balance = await transaction.executor.updateTable("ai_funded_runtime_balances").set({
        credit_balance_microusd: sql<number>`credit_balance_microusd + ${grant.amountMicrousd}`,
        ...bucketUpdate,
        updated_at: at,
      }).where("machine_id", "=", grant.identity.machineId)
        .where("owner_id", "=", grant.identity.ownerId)
        .where("runtime_slot", "=", grant.identity.runtimeSlot)
        .where(sql<boolean>`credit_balance_microusd <= ${Number.MAX_SAFE_INTEGER - grant.amountMicrousd}`)
        .returning("machine_id").executeTakeFirst();
      if (!balance) throw new Error("Funded AI credit balance exceeds supported bounds");
    }
    return { ...grant, createdAt: stored.created_at };
  }


  async function grantCredit(input: z.input<typeof GrantSchema>) {
    await options.db.ready;
    const createdAt = options.now().toISOString();
    return options.db.transaction((trx) => grantCreditInTransaction(trx, input, createdAt));
  }


  async function checkPolicy(
    input: z.input<typeof FundedAiPolicyCheckRequestSchema>,
  ): Promise<FundedAiPolicyCheckResponse> {
    const request = FundedAiPolicyCheckRequestSchema.parse(input);
    const tokenMatch = TOKEN_PATTERN.exec(request.credential);
    if (!tokenMatch) throw new AiFundedPolicyError("unauthorized");
    const checked = options.now();
    const checkedAt = checked.toISOString();
    await options.db.ready;
    const row = await options.db.executor.selectFrom("ai_runtime_credentials as credential")
      .innerJoin("ai_funded_runtime_policies as runtime", "runtime.machine_id", "credential.machine_id")
      .innerJoin("user_machines as machine", "machine.machine_id", "credential.machine_id")
      .leftJoin("ai_funded_credit_restrictions as restriction", "restriction.machine_id", "credential.machine_id")
      .innerJoin("ai_funded_global_policy as global_policy", (join) => (
        join.on("global_policy.policy_id", "=", "default")
      ))
      .select([
        "credential.token_id", "credential.token_hash", "credential.owner_id", "credential.machine_id",
        "credential.runtime_slot", "credential.audience", "credential.scope", "credential.expires_at",
        "credential.revoked_at", "runtime.owner_id as runtime_owner_id",
        "runtime.runtime_slot as policy_runtime_slot", "runtime.enabled as runtime_enabled",
        "runtime.expires_at as runtime_expires_at", "runtime.revision as runtime_revision",
        "runtime.allowed_model_ids as runtime_models", "runtime.monthly_budget_microusd",
        "machine.clerk_user_id", "machine.runtime_slot as machine_runtime_slot", "machine.status",
        "machine.activation_state", "machine.deleted_at", "global_policy.enabled as global_enabled",
        "global_policy.revision as global_revision", "global_policy.allowed_model_ids as global_models",
        "restriction.debt_microusd as funding_debt_microusd", "restriction.frozen as funding_frozen",
      ])
      .where("credential.token_id", "=", tokenMatch[1])
      .where("global_policy.policy_id", "=", "default")
      .executeTakeFirst();
    if (!row || !hashesEqual(row.token_hash, hashCredential(request.credential))
      || row.revoked_at !== null || Date.parse(row.expires_at) <= checked.getTime()
      || row.audience !== FUNDED_AI_AUDIENCE || row.scope !== FUNDED_AI_SCOPE
      || row.clerk_user_id !== row.owner_id || row.machine_runtime_slot !== row.runtime_slot
      || row.status !== "running" || row.activation_state !== "authorized" || row.deleted_at !== null
      || row.runtime_owner_id !== row.owner_id || row.policy_runtime_slot !== row.runtime_slot) {
      throw new AiFundedPolicyError("unauthorized");
    }
    if (!row.global_enabled || !row.runtime_enabled
      || row.funding_frozen === true || exactInteger(row.funding_debt_microusd ?? 0) > 0
      || (row.runtime_expires_at !== null && Date.parse(row.runtime_expires_at) <= checked.getTime())) {
      throw new AiFundedPolicyError("access_disabled");
    }
    const allowedModelIds = intersectModels(parseModels(row.global_models), parseModels(row.runtime_models));
    if (!allowedModelIds.includes(request.modelId)) throw new AiFundedPolicyError("model_not_allowed");
    return FundedAiPolicyCheckResponseSchema.parse({
      contractVersion: 1,
      authorized: true,
      identity: {
        tokenId: row.token_id,
        ownerId: row.owner_id,
        machineId: row.machine_id,
        runtimeSlot: row.runtime_slot,
        audience: FUNDED_AI_AUDIENCE,
        scope: FUNDED_AI_SCOPE,
        expiresAt: row.expires_at,
      },
      policy: {
        enabled: true,
        globalRevision: row.global_revision,
        runtimeRevision: row.runtime_revision,
        allowedModelIds,
        monthlyBudgetMicrousd: exactInteger(row.monthly_budget_microusd),
        checkedAt,
        staleAfter: new Date(checked.getTime() + options.policyFreshnessMs).toISOString(),
      },
    });
  }


  async function cleanupExpiredReservations(input: z.input<typeof CleanupSchema>): Promise<number> {
    const { limit } = CleanupSchema.parse(input);
    const checked = options.now();
    const checkedAt = checked.toISOString();
    const currentPeriod = utcMonthStart(checked);
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const expired = await trx.executor.selectFrom("ai_funded_usage_reservations")
        .select([
          "reservation_id", "request_id", "token_id", "owner_id", "machine_id", "runtime_slot",
          "period_start", "reserved_microusd", "promotional_reserved_microusd",
          "addon_reserved_microusd", "status",
        ])
        .where("status", "in", ["reserved", "in_flight"]).where("expires_at", "<=", checkedAt)
        .orderBy("expires_at").orderBy("reservation_id").limit(limit).forUpdate().skipLocked().execute();
      let cleaned = 0;
      for (const reservation of expired) {
        const reservationIdentity = {
          ownerId: reservation.owner_id,
          machineId: reservation.machine_id,
          runtimeSlot: reservation.runtime_slot,
        };
        if (reservation.status === "in_flight") {
          // Preserve explicit grant allocations while the reservation remains
          // active, but retire expired, unattributed legacy backing before
          // choosing debit sources for conservative cleanup settlement.
          await reconcileExpiredPromotionalCredit(
            trx.executor,
            reservationIdentity,
            checkedAt,
          );
        }
        const claimedStatus = reservation.status === "in_flight" ? "settling" : "expired";
        const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
          .set({ status: claimedStatus }).where("reservation_id", "=", reservation.reservation_id)
          .where("status", "=", reservation.status).returning("reservation_id").executeTakeFirst();
        if (!claimed) continue;
        cleaned += 1;
        const reserved = exactInteger(reservation.reserved_microusd);
        const currentBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
          month_period_start: currentPeriod,
          month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_spent_microusd ELSE 0 END`,
          month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${currentPeriod} THEN month_reserved_microusd ELSE 0 END`,
          updated_at: checkedAt,
        }).where("machine_id", "=", reservation.machine_id).returningAll().executeTakeFirstOrThrow();
        if (reservation.status === "in_flight") {
          const { promotionalDebit, addonDebit, attributed } = await reservationDebitSplit(
            trx.executor,
            reservationIdentity,
            reservation,
            reserved,
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
          if (attributed && chargedMicrousd !== reserved) {
            throw new Error("Funded AI attributed reservation debit invariant violated");
          }
          await recordUsageFunding(
            trx.executor,
            reservation,
            reserved,
            appliedPromotionalDebit,
            addonDebit,
            checkedAt,
          );
          const runtime = await trx.executor.selectFrom("ai_funded_runtime_policies")
            .select("monthly_budget_microusd").where("machine_id", "=", reservation.machine_id)
            .executeTakeFirstOrThrow();
          const balance = await reconcileExpiredPromotionalCredit(trx.executor, {
            ownerId: reservation.owner_id,
            machineId: reservation.machine_id,
            runtimeSlot: reservation.runtime_slot,
          }, checkedAt);
          const funding = fundingSummary(balance, exactInteger(runtime.monthly_budget_microusd), checkedAt);
          const response = FundedAiSettlementResponseSchema.parse({
            contractVersion: 1,
            reservationId: reservation.reservation_id,
            requestId: reservation.request_id,
            tokenId: reservation.token_id,
            actualCostMicrousd: reserved,
            releasedMicrousd: 0,
            remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
            remainingBudgetMicrousd: funding.remainingBudgetMicrousd,
            funding,
            settledAt: checkedAt,
            status: "settled",
          });
          const settled = await trx.executor.updateTable("ai_funded_usage_reservations").set({
            status: "settled", actual_microusd: reserved, settled_at: checkedAt,
            finalization_mode: "conservative",
            settlement_response: JSON.stringify(response),
          }).where("reservation_id", "=", reservation.reservation_id).where("status", "=", "settling")
            .returning("reservation_id").executeTakeFirst();
          if (!settled) throw new Error("Funded AI reservation invariant violated");
          continue;
        }
        const balance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
          reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
          month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
          updated_at: checkedAt,
        }).where("machine_id", "=", reservation.machine_id)
          .where(sql<boolean>`reserved_microusd >= ${reserved}`)
          .returning("machine_id").executeTakeFirst();
        if (!balance) throw new Error("Funded AI balance invariant violated");
        await reconcileExpiredPromotionalCredit(trx.executor, {
          ownerId: reservation.owner_id,
          machineId: reservation.machine_id,
          runtimeSlot: reservation.runtime_slot,
        }, checkedAt);
      }
      return cleaned;
    });
  }
  return { getRuntimeFundingSummary, getFundingSummary, grantCreditInTransaction, grantCredit, checkPolicy, cleanupExpiredReservations };
}
