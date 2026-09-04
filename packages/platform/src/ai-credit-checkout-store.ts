import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { AiCreditPackageId } from "./ai-credit-checkout.js";
import type { PlatformDB, PlatformDatabase } from "./db.js";

const CHECKOUT_WINDOW_MS = 60 * 60_000;
const CHECKOUT_ACTIVE_MS = 24 * 60 * 60_000;
export const AI_CREDIT_CHECKOUTS_PER_HOUR = 5;

export class AiCreditCheckoutStoreError extends Error {
  constructor(readonly code: "conflict" | "rate_limited" | "not_found" | "verification_failed") {
    super(code);
  }
}

export interface AiCreditCheckoutClaimInput {
  requestId: string;
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
  packageId: AiCreditPackageId;
  priceId: string;
  amountMicrousd: number;
  amountCents: number;
  currency: "usd";
  automaticTax: boolean;
  idempotencyKey: string;
}

export type AiCreditCheckoutClaim = PlatformDatabase["ai_credit_checkout_claims"];

function exactClaimMatch(row: PlatformDatabase["ai_credit_checkout_claims"], input: AiCreditCheckoutClaimInput) {
  return row.owner_id === input.ownerId && row.machine_id === input.machineId
    && row.runtime_slot === input.runtimeSlot && row.package_id === input.packageId
    && row.stripe_price_id === input.priceId && Number(row.amount_microusd) === input.amountMicrousd
    && row.amount_cents === input.amountCents && row.currency === input.currency
    && row.automatic_tax === input.automaticTax && row.idempotency_key === input.idempotencyKey;
}

function sameRequestMatch(row: PlatformDatabase["ai_credit_checkout_claims"], input: AiCreditCheckoutClaimInput) {
  return row.owner_id === input.ownerId && row.machine_id === input.machineId
    && row.runtime_slot === input.runtimeSlot && row.package_id === input.packageId
    && row.idempotency_key === input.idempotencyKey;
}

export async function prepareAiCreditCheckoutClaim(
  db: PlatformDB,
  input: AiCreditCheckoutClaimInput,
  at: Date,
) {
  const createdAt = at.toISOString();
  const expiresAt = new Date(at.getTime() + CHECKOUT_ACTIVE_MS).toISOString();
  const windowStart = new Date(at.getTime() - CHECKOUT_WINDOW_MS).toISOString();
  return db.transaction(async (trx) => {
    const machine = await trx.executor.selectFrom("user_machines").select([
      "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at",
    ]).where("machine_id", "=", input.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== input.ownerId || machine.runtime_slot !== input.runtimeSlot
      || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) {
      throw new AiCreditCheckoutStoreError("verification_failed");
    }
    await trx.executor.updateTable("ai_credit_checkout_claims").set({
      status: "expired", updated_at: createdAt,
    }).where("owner_id", "=", input.ownerId).where("runtime_slot", "=", input.runtimeSlot)
      .where("status", "in", ["creating", "open", "awaiting_payment"])
      .where("expires_at", "<=", createdAt).execute();

    const existing = await trx.executor.selectFrom("ai_credit_checkout_claims")
      .selectAll().where("request_id", "=", input.requestId).forUpdate().executeTakeFirst();
    if (existing) {
      if (!sameRequestMatch(existing, input)) throw new AiCreditCheckoutStoreError("conflict");
      return existing;
    }
    const active = await trx.executor.selectFrom("ai_credit_checkout_claims").selectAll()
      .where("owner_id", "=", input.ownerId).where("runtime_slot", "=", input.runtimeSlot)
      .where("status", "in", ["creating", "open", "awaiting_payment"])
      .forUpdate().executeTakeFirst();
    if (active) {
      if (active.machine_id !== input.machineId || active.package_id !== input.packageId) {
        throw new AiCreditCheckoutStoreError("conflict");
      }
      return active;
    }
    const recent = await trx.executor.selectFrom("ai_credit_checkout_claims")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("owner_id", "=", input.ownerId).where("runtime_slot", "=", input.runtimeSlot)
      .where("created_at", ">=", windowStart)
      .executeTakeFirstOrThrow();
    if (Number(recent.count) >= AI_CREDIT_CHECKOUTS_PER_HOUR) {
      throw new AiCreditCheckoutStoreError("rate_limited");
    }
    await trx.executor.insertInto("ai_credit_checkout_claims").values({
      request_id: input.requestId, owner_id: input.ownerId, machine_id: input.machineId,
      runtime_slot: input.runtimeSlot, package_id: input.packageId, stripe_price_id: input.priceId,
      amount_microusd: input.amountMicrousd, amount_cents: input.amountCents, currency: input.currency,
      automatic_tax: input.automaticTax, idempotency_key: input.idempotencyKey,
      stripe_session_id: null, checkout_url: null, payment_intent_id: null, charge_id: null,
      status: "creating", granted_microusd: 0, reversed_microusd: 0,
      reversal_debt_microusd: 0, refunded_at: null, dispute_status: "none",
      created_at: createdAt, updated_at: createdAt, expires_at: expiresAt,
    }).onConflict((conflict) => conflict.column("request_id").doNothing()).execute();
    const stored = await trx.executor.selectFrom("ai_credit_checkout_claims").selectAll()
      .where("request_id", "=", input.requestId).executeTakeFirstOrThrow();
    if (!exactClaimMatch(stored, input)) throw new AiCreditCheckoutStoreError("conflict");
    return stored;
  });
}

export async function finalizeAiCreditCheckoutClaim(
  db: PlatformDB,
  requestId: string,
  session: { id: string; url: string },
  at: string,
) {
  return db.transaction(async (trx) => {
    await trx.executor.updateTable("ai_credit_checkout_claims").set({
      stripe_session_id: session.id, checkout_url: session.url, status: "open", updated_at: at,
    }).where("request_id", "=", requestId).where("stripe_session_id", "is", null).execute();
    const stored = await trx.executor.selectFrom("ai_credit_checkout_claims").selectAll()
      .where("request_id", "=", requestId).forUpdate().executeTakeFirst();
    if (!stored || stored.stripe_session_id !== session.id || stored.checkout_url !== session.url) {
      throw new AiCreditCheckoutStoreError("conflict");
    }
    return stored;
  });
}

export async function getClaimByRequestId(db: PlatformDB, requestId: string, lock = false) {
  let query = db.executor.selectFrom("ai_credit_checkout_claims").selectAll()
    .where("request_id", "=", requestId);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function getClaimByPaymentReference(
  db: PlatformDB,
  paymentIntentId: string | null,
  chargeId: string | null,
) {
  if (!paymentIntentId && !chargeId) return undefined;
  return db.executor.selectFrom("ai_credit_checkout_claims").selectAll()
    .where((eb) => eb.or([
      ...(paymentIntentId ? [eb("payment_intent_id", "=", paymentIntentId)] : []),
      ...(chargeId ? [eb("charge_id", "=", chargeId)] : []),
    ])).forUpdate().executeTakeFirst();
}

export async function markClaimSession(
  trx: PlatformDB,
  input: { requestId: string; sessionId: string; paymentIntentId: string | null; status: string; at: string },
) {
  const allowedPriorStatuses = input.status === "paid"
    ? ["creating", "open", "awaiting_payment", "payment_failed", "paid"]
    : input.status === "awaiting_payment"
      ? ["creating", "open", "awaiting_payment"]
      : input.status === "payment_failed"
        ? ["creating", "open", "awaiting_payment", "payment_failed"]
        : ["creating", "open", "awaiting_payment", "payment_failed", "expired"];
  const updated = await trx.executor.updateTable("ai_credit_checkout_claims").set({
    stripe_session_id: input.sessionId,
    ...(input.paymentIntentId ? { payment_intent_id: input.paymentIntentId } : {}),
    status: input.status,
    updated_at: input.at,
  }).where("request_id", "=", input.requestId)
    .where("status", "in", allowedPriorStatuses)
    .where((eb) => eb.or([eb("stripe_session_id", "is", null), eb("stripe_session_id", "=", input.sessionId)]))
    .returningAll().executeTakeFirst();
  if (!updated) throw new AiCreditCheckoutStoreError("verification_failed");
  return updated;
}

export async function reverseClaimCredit(
  trx: PlatformDB,
  claim: PlatformDatabase["ai_credit_checkout_claims"],
  sourceReference: string,
  at: string,
  freeze: boolean,
) {
  if (Number(claim.granted_microusd) <= 0) return claim;
  if (Number(claim.reversed_microusd) > 0) {
    if (freeze) {
      // A refund may have already reversed the grant without freezing the
      // runtime. A later dispute must still apply its restriction atomically.
      await trx.executor.insertInto("ai_funded_credit_restrictions").values({
        machine_id: claim.machine_id,
        owner_id: claim.owner_id,
        runtime_slot: claim.runtime_slot,
        debt_microusd: 0,
        frozen: true,
        updated_at: at,
      }).onConflict((conflict) => conflict.column("machine_id").doUpdateSet({
        frozen: true,
        updated_at: at,
      })).execute();
    }
    return claim;
  }
  const balance = await trx.executor.selectFrom("ai_funded_runtime_balances").selectAll()
    .where("machine_id", "=", claim.machine_id).forUpdate().executeTakeFirstOrThrow();
  const removable = Math.min(
    Number(claim.granted_microusd), Number(balance.addon_balance_microusd),
    Math.max(0, Number(balance.credit_balance_microusd) - Number(balance.reserved_microusd)),
  );
  const debt = Number(claim.granted_microusd) - removable;
  if (removable > 0) {
    const reversalId = createHash("sha256").update(sourceReference).digest("hex").slice(0, 16);
    const inserted = await trx.executor.insertInto("ai_funded_credit_ledger").values({
      entry_id: `addon-reversal:${claim.request_id}:${reversalId}`, owner_id: claim.owner_id,
      machine_id: claim.machine_id, runtime_slot: claim.runtime_slot, kind: "addon_reversal",
      amount_microusd: -removable, source_reference: sourceReference, reservation_id: null,
      period_start: null, expires_at: null, created_at: at,
    }).onConflict((conflict) => conflict.column("entry_id").doNothing())
      .returning("entry_id").executeTakeFirst();
    if (inserted) {
      await trx.executor.updateTable("ai_funded_runtime_balances").set({
        credit_balance_microusd: sql<number>`credit_balance_microusd - ${removable}`,
        addon_balance_microusd: sql<number>`addon_balance_microusd - ${removable}`,
        updated_at: at,
      }).where("machine_id", "=", claim.machine_id).execute();
    }
  }
  await trx.executor.insertInto("ai_funded_credit_restrictions").values({
    machine_id: claim.machine_id, owner_id: claim.owner_id, runtime_slot: claim.runtime_slot,
    debt_microusd: debt, frozen: freeze || debt > 0, updated_at: at,
  }).onConflict((conflict) => conflict.column("machine_id").doUpdateSet({
    debt_microusd: sql<number>`ai_funded_credit_restrictions.debt_microusd + ${debt}`,
    frozen: sql<boolean>`ai_funded_credit_restrictions.frozen OR ${freeze || debt > 0}`,
    updated_at: at,
  })).execute();
  return trx.executor.updateTable("ai_credit_checkout_claims").set({
    reversed_microusd: Number(claim.granted_microusd), reversal_debt_microusd: debt, updated_at: at,
  }).where("request_id", "=", claim.request_id).where("reversed_microusd", "=", 0)
    .returningAll().executeTakeFirstOrThrow();
}

export async function settleWonDisputeCredit(
  trx: PlatformDB,
  claim: PlatformDatabase["ai_credit_checkout_claims"],
  at: string,
) {
  const shouldRestore = claim.refunded_at === null && Number(claim.reversed_microusd) > 0;
  const restoreToBalance = shouldRestore
    ? Number(claim.reversed_microusd) - Number(claim.reversal_debt_microusd)
    : 0;
  if (restoreToBalance > 0) {
    const restoreId = createHash("sha256").update(claim.charge_id ?? claim.request_id).digest("hex").slice(0, 16);
    const inserted = await trx.executor.insertInto("ai_funded_credit_ledger").values({
      entry_id: `addon-restore:${claim.request_id}:${restoreId}`, owner_id: claim.owner_id, machine_id: claim.machine_id,
      runtime_slot: claim.runtime_slot, kind: "addon_grant", amount_microusd: restoreToBalance,
      source_reference: claim.charge_id ?? claim.payment_intent_id ?? claim.request_id,
      reservation_id: null, period_start: null, expires_at: null, created_at: at,
    }).onConflict((conflict) => conflict.column("entry_id").doNothing())
      .returning("entry_id").executeTakeFirst();
    if (inserted) {
      const restored = await trx.executor.updateTable("ai_funded_runtime_balances").set({
        credit_balance_microusd: sql<number>`credit_balance_microusd + ${restoreToBalance}`,
        addon_balance_microusd: sql<number>`addon_balance_microusd + ${restoreToBalance}`,
        updated_at: at,
      }).where("machine_id", "=", claim.machine_id)
        .where(sql<boolean>`credit_balance_microusd <= ${Number.MAX_SAFE_INTEGER - restoreToBalance}`)
        .where(sql<boolean>`addon_balance_microusd <= ${Number.MAX_SAFE_INTEGER - restoreToBalance}`)
        .returning("machine_id").executeTakeFirst();
      if (!restored) throw new Error("Funded AI credit restoration exceeds supported bounds");
    }
  }
  if (shouldRestore) {
    await trx.executor.updateTable("ai_credit_checkout_claims").set({
      reversed_microusd: 0, reversal_debt_microusd: 0, updated_at: at,
    }).where("request_id", "=", claim.request_id).where("dispute_status", "=", "won").execute();
  }
  const clearedDebt = shouldRestore ? Number(claim.reversal_debt_microusd) : 0;
  await trx.executor.updateTable("ai_funded_credit_restrictions").set({
    debt_microusd: sql<number>`GREATEST(0, debt_microusd - ${clearedDebt})`,
    frozen: sql<boolean>`
      GREATEST(0, debt_microusd - ${clearedDebt}) > 0
      OR EXISTS (
        SELECT 1 FROM ai_credit_checkout_claims adverse
        WHERE adverse.machine_id = ${claim.machine_id}
          AND adverse.dispute_status IN ('open', 'lost')
      )
    `,
    updated_at: at,
  }).where("machine_id", "=", claim.machine_id).execute();
}
