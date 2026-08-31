import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  FUNDED_AI_AUDIENCE,
  FUNDED_AI_SCOPE,
  FundedAiAuthorizationRequestSchema,
  FundedAiAuthorizationResponseSchema,
  FundedAiFundingSummarySchema,
  FundedAiReleaseRequestSchema,
  FundedAiReleaseResponseSchema,
  FundedAiSettlementRequestSchema,
  FundedAiSettlementResponseSchema,
  FundedAiStartRequestSchema,
  FundedAiStartResponseSchema,
  IsoTimestampSchema,
  type FundedAiAuthorizationResponse,
  type FundedAiFundingSummary,
  type FundedAiReleaseResponse,
  type FundedAiSettlementResponse,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import {
  debitAttributedPromotionalGrants,
  debitPromotionalGrants,
  reconcileExpiredPromotionalCredit,
  reservationDebitSplit,
  reserveFundingSources,
} from "./ai-funded-reservation-sources.js";

const TOKEN_PATTERN = /^sk-matrix-funded-([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})\.([A-Za-z0-9_-]{43})$/;
const ReferenceSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const IdentitySchema = z.object({
  ownerId: ReferenceSchema,
  machineId: ReferenceSchema,
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
}).strict();
const MoneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const GrantSchema = z.object({
  entryId: ReferenceSchema,
  identity: IdentitySchema,
  kind: z.enum(["promotional_grant", "addon_grant"]),
  amountMicrousd: MoneySchema.min(1),
  sourceReference: ReferenceSchema,
  expiresAt: IsoTimestampSchema.nullable().optional().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "addon_grant" && value.expiresAt !== null) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Add-on credit cannot expire" });
  }
});
const CleanupSchema = z.object({ limit: z.number().int().min(1).max(1_000) }).strict();
const ModelIdsSchema = z.array(z.string().min(3).max(200)).max(64);
const MAX_PROMOTIONAL_GRANTS_PER_RUNTIME = 64;

export interface AiFundedMeteringRepositoryOptions {
  db: PlatformDB;
  credentialHashSecret: string;
  now: () => Date;
  policyFreshnessMs: number;
  reservationTtlMs: number;
  inFlightTtlMs: number;
  reservationIdFactory?: () => string;
}

type BalanceSnapshot = {
  credit_balance_microusd: unknown;
  promotional_balance_microusd: unknown;
  addon_balance_microusd: unknown;
  reserved_microusd: unknown;
  month_period_start: string;
  month_spent_microusd: unknown;
  month_reserved_microusd: unknown;
};

function exactInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Funded AI monetary total exceeds safe integer range");
  return parsed;
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseModels(value: string): string[] {
  try {
    return ModelIdsSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error("Invalid funded AI policy model configuration", { cause: error });
  }
}

function intersectModels(globalModels: string[], runtimeModels: string[]): string[] {
  const runtimeSet = new Set(runtimeModels);
  return globalModels.filter((model) => runtimeSet.has(model));
}

function utcMonthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

function fundingSummary(
  balance: BalanceSnapshot,
  monthlyBudgetMicrousd: number,
  asOf: string,
): FundedAiFundingSummary {
  const creditBalanceMicrousd = exactInteger(balance.credit_balance_microusd);
  const reservedMicrousd = exactInteger(balance.reserved_microusd);
  const settledThisMonthMicrousd = exactInteger(balance.month_spent_microusd);
  const reservedThisMonthMicrousd = exactInteger(balance.month_reserved_microusd);
  return FundedAiFundingSummarySchema.parse({
    asOf,
    periodStart: balance.month_period_start,
    monthlyBudgetMicrousd,
    settledThisMonthMicrousd,
    reservedMicrousd,
    reservedThisMonthMicrousd,
    promotionalBalanceMicrousd: exactInteger(balance.promotional_balance_microusd),
    addonBalanceMicrousd: exactInteger(balance.addon_balance_microusd),
    creditBalanceMicrousd,
    remainingBalanceMicrousd: Math.max(0, creditBalanceMicrousd - reservedMicrousd),
    remainingBudgetMicrousd: Math.max(
      0,
      monthlyBudgetMicrousd - settledThisMonthMicrousd - reservedThisMonthMicrousd,
    ),
  });
}

export function createAiFundedMeteringRepository(options: AiFundedMeteringRepositoryOptions) {
  if (!options.db || options.credentialHashSecret.length < 32) {
    throw new Error("Funded AI metering dependencies are misconfigured");
  }
  if (options.policyFreshnessMs < 1_000 || options.policyFreshnessMs > 5 * 60_000
    || options.reservationTtlMs < 30_000 || options.reservationTtlMs > 15 * 60_000
    || options.inFlightTtlMs < 60_000 || options.inFlightTtlMs > 60 * 60_000) {
    throw new Error("Funded AI metering time limits are misconfigured");
  }
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

  async function grantCredit(input: z.input<typeof GrantSchema>) {
    const grant = GrantSchema.parse(input);
    const at = options.now().toISOString();
    if (grant.expiresAt !== null && grant.expiresAt <= at) {
      throw new AiFundedPolicyError("access_disabled");
    }
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const machine = await trx.executor.selectFrom("user_machines").select([
        "machine_id", "clerk_user_id", "runtime_slot", "deleted_at",
      ]).where("machine_id", "=", grant.identity.machineId).forUpdate().executeTakeFirst();
      if (!machine || machine.clerk_user_id !== grant.identity.ownerId
        || machine.runtime_slot !== grant.identity.runtimeSlot || machine.deleted_at !== null) {
        throw new AiFundedPolicyError("identity_mismatch");
      }
      const inserted = await trx.executor.insertInto("ai_funded_credit_ledger").values({
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
      const stored = await trx.executor.selectFrom("ai_funded_credit_ledger")
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
          await reconcileExpiredPromotionalCredit(trx.executor, grant.identity, at);
          const activeGrantCount = await trx.executor.selectFrom("ai_funded_promotional_grant_balances")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("owner_id", "=", grant.identity.ownerId)
            .where("machine_id", "=", grant.identity.machineId)
            .where("runtime_slot", "=", grant.identity.runtimeSlot)
            .where("remaining_microusd", ">", 0).executeTakeFirstOrThrow();
          if (exactInteger(activeGrantCount.count) >= MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
            throw new AiFundedPolicyError("rate_limited");
          }
          await trx.executor.insertInto("ai_funded_promotional_grant_balances").values({
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
        const balance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
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
    });
  }

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
      if (!runtime || !machine || machine.clerk_user_id !== credential.owner_id
        || machine.runtime_slot !== credential.runtime_slot || machine.status !== "running"
        || machine.activation_state !== "authorized" || machine.deleted_at !== null
        || runtime.owner_id !== credential.owner_id || runtime.runtime_slot !== credential.runtime_slot) {
        throw new AiFundedPolicyError("unauthorized");
      }
      if (!global.enabled || !runtime.enabled
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
        .where(sql<boolean>`credit_balance_microusd - reserved_microusd >= ${request.maxCostMicrousd}`)
        .where(sql<boolean>`${monthlyBudget} - month_spent_microusd - month_reserved_microusd >= ${request.maxCostMicrousd}`)
        .returning([
          "credit_balance_microusd", "promotional_balance_microusd", "addon_balance_microusd",
          "reserved_microusd", "month_period_start", "month_spent_microusd", "month_reserved_microusd",
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
      const remainingBalance = exactInteger(reserved.credit_balance_microusd) - exactInteger(reserved.reserved_microusd);
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
    const checked = options.now();
    const checkedAt = checked.toISOString();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
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
      if (reservation.status === "settled") {
        if (exactInteger(reservation.actual_microusd) !== request.actualCostMicrousd) {
          throw new AiFundedPolicyError("idempotency_conflict");
        }
        if (reservation.settlement_response === null) throw new Error("Settled reservation is missing its response");
        return FundedAiSettlementResponseSchema.parse(JSON.parse(reservation.settlement_response));
      }
      if (reservation.status !== "in_flight" && reservation.status !== "expired") {
        throw new AiFundedPolicyError("reservation_closed");
      }
      if (reservation.status === "expired" || Date.parse(reservation.expires_at) <= checked.getTime()) {
        throw new AiFundedPolicyError("reservation_expired");
      }
      const reserved = exactInteger(reservation.reserved_microusd);
      if (request.actualCostMicrousd > reserved) throw new AiFundedPolicyError("over_settlement");
      const claimed = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ status: "settling" }).where("reservation_id", "=", reservation.reservation_id)
        .where("status", "=", "in_flight").returning("reservation_id").executeTakeFirst();
      if (!claimed) {
        const latest = await trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
          .where("reservation_id", "=", reservation.reservation_id).executeTakeFirstOrThrow();
        if (latest.status === "settled" && exactInteger(latest.actual_microusd) === request.actualCostMicrousd
          && latest.settlement_response !== null) {
          return FundedAiSettlementResponseSchema.parse(JSON.parse(latest.settlement_response));
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
      const reservationIdentity = {
        ownerId: reservation.owner_id,
        machineId: reservation.machine_id,
        runtimeSlot: reservation.runtime_slot,
      };
      const { promotionalDebit, addonDebit, attributed } = await reservationDebitSplit(
        trx.executor,
        reservationIdentity,
        reservation,
        request.actualCostMicrousd,
        currentBalance,
      );
      if (attributed) {
        await debitAttributedPromotionalGrants(
          trx.executor,
          reservation.reservation_id,
          promotionalDebit,
          checkedAt,
        );
      } else {
        await debitPromotionalGrants(trx.executor, reservationIdentity, promotionalDebit, checkedAt);
      }
      if (promotionalDebit > 0) {
        await trx.executor.insertInto("ai_funded_credit_ledger").values({
          entry_id: `usage:${reservation.reservation_id}:promotional`,
          owner_id: reservation.owner_id,
          machine_id: reservation.machine_id,
          runtime_slot: reservation.runtime_slot,
          kind: "promotional_debit",
          amount_microusd: -promotionalDebit,
          source_reference: reservation.request_id,
          reservation_id: reservation.reservation_id,
          period_start: reservation.period_start,
          expires_at: null,
          created_at: checkedAt,
        }).execute();
      }
      if (addonDebit > 0) {
        await trx.executor.insertInto("ai_funded_credit_ledger").values({
          entry_id: `usage:${reservation.reservation_id}:addon`,
          owner_id: reservation.owner_id,
          machine_id: reservation.machine_id,
          runtime_slot: reservation.runtime_slot,
          kind: "addon_debit",
          amount_microusd: -addonDebit,
          source_reference: reservation.request_id,
          reservation_id: reservation.reservation_id,
          period_start: reservation.period_start,
          expires_at: null,
          created_at: checkedAt,
        }).execute();
      }
      const debitedBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        credit_balance_microusd: sql<number>`credit_balance_microusd - ${request.actualCostMicrousd}`,
        promotional_balance_microusd: sql<number>`promotional_balance_microusd - ${promotionalDebit}`,
        addon_balance_microusd: sql<number>`addon_balance_microusd - ${addonDebit}`,
        reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_spent_microusd + ${request.actualCostMicrousd} ELSE month_spent_microusd END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
        updated_at: checkedAt,
      }).where("machine_id", "=", reservation.machine_id)
        .where(sql<boolean>`reserved_microusd >= ${reserved}`)
        .where(sql<boolean>`credit_balance_microusd >= ${request.actualCostMicrousd}`)
        .returningAll().executeTakeFirst();
      if (!debitedBalance) throw new Error("Funded AI balance invariant violated");
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
        status: "settled",
        actual_microusd: request.actualCostMicrousd,
        settled_at: checkedAt,
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
        actualCostMicrousd: request.actualCostMicrousd,
        releasedMicrousd: reserved - request.actualCostMicrousd,
        remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
        remainingBudgetMicrousd: funding.remainingBudgetMicrousd,
        funding,
        settledAt: checkedAt,
        status: "settled",
      });
      await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ settlement_response: JSON.stringify(response) })
        .where("reservation_id", "=", reservation.reservation_id).execute();
      return response;
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
          const reservationIdentity = {
            ownerId: reservation.owner_id,
            machineId: reservation.machine_id,
            runtimeSlot: reservation.runtime_slot,
          };
          const hasUnknownLegacySource = reservation.promotional_reserved_microusd === null
            && reservation.addon_reserved_microusd === null;
          if (hasUnknownLegacySource && exactInteger(currentBalance.credit_balance_microusd) < reserved) {
            // A migrated reservation without source attribution cannot safely
            // debit credit that has since expired. Release its aggregate hold
            // atomically instead of inventing a source or aborting the batch.
            const releasedBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
              reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
              month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
              updated_at: checkedAt,
            }).where("machine_id", "=", reservation.machine_id)
              .where(sql<boolean>`reserved_microusd >= ${reserved}`)
              .returning("machine_id").executeTakeFirst();
            if (!releasedBalance) throw new Error("Funded AI balance invariant violated");
            const expiredReservation = await trx.executor.updateTable("ai_funded_usage_reservations")
              .set({ status: "expired" })
              .where("reservation_id", "=", reservation.reservation_id)
              .where("status", "=", "settling")
              .returning("reservation_id").executeTakeFirst();
            if (!expiredReservation) throw new Error("Funded AI reservation invariant violated");
            continue;
          }
          const { promotionalDebit, addonDebit, attributed } = await reservationDebitSplit(
            trx.executor,
            reservationIdentity,
            reservation,
            reserved,
            currentBalance,
          );
          if (attributed) {
            await debitAttributedPromotionalGrants(
              trx.executor,
              reservation.reservation_id,
              promotionalDebit,
              checkedAt,
            );
          } else {
            await debitPromotionalGrants(trx.executor, reservationIdentity, promotionalDebit, checkedAt);
          }
          const debitRows = [
            promotionalDebit > 0 ? {
              entry_id: `usage:${reservation.reservation_id}:promotional`,
              owner_id: reservation.owner_id,
              machine_id: reservation.machine_id,
              runtime_slot: reservation.runtime_slot,
              kind: "promotional_debit",
              amount_microusd: -promotionalDebit,
              source_reference: reservation.request_id,
              reservation_id: reservation.reservation_id,
              period_start: reservation.period_start,
              expires_at: null,
              created_at: checkedAt,
            } : null,
            addonDebit > 0 ? {
              entry_id: `usage:${reservation.reservation_id}:addon`,
              owner_id: reservation.owner_id,
              machine_id: reservation.machine_id,
              runtime_slot: reservation.runtime_slot,
              kind: "addon_debit",
              amount_microusd: -addonDebit,
              source_reference: reservation.request_id,
              reservation_id: reservation.reservation_id,
              period_start: reservation.period_start,
              expires_at: null,
              created_at: checkedAt,
            } : null,
          ].filter((row): row is NonNullable<typeof row> => row !== null);
          if (debitRows.length > 0) await trx.executor.insertInto("ai_funded_credit_ledger").values(debitRows).execute();
          const debitedBalance = await trx.executor.updateTable("ai_funded_runtime_balances").set({
            credit_balance_microusd: sql<number>`credit_balance_microusd - ${reserved}`,
            promotional_balance_microusd: sql<number>`promotional_balance_microusd - ${promotionalDebit}`,
            addon_balance_microusd: sql<number>`addon_balance_microusd - ${addonDebit}`,
            reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
            month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_spent_microusd + ${reserved} ELSE month_spent_microusd END`,
            month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`,
            updated_at: checkedAt,
          }).where("machine_id", "=", reservation.machine_id)
            .where(sql<boolean>`reserved_microusd >= ${reserved}`)
            .where(sql<boolean>`credit_balance_microusd >= ${reserved}`)
            .returningAll().executeTakeFirst();
          if (!debitedBalance) throw new Error("Funded AI balance invariant violated");
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

  return {
    getFundingSummary,
    getRuntimeFundingSummary,
    authorize,
    startReservation,
    settleReservation,
    releaseReservation,
    cleanupExpiredReservations,
    grantCredit,
  };
}
