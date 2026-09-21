import { timingSafeEqual } from "node:crypto";
import { FundedAiFundingSummarySchema, type FundedAiFundingSummary } from "@matrix-os/contracts";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
const ModelIdsSchema = z.array(z.string().min(3).max(200)).max(64);

type BalanceSnapshot = {
  credit_balance_microusd: unknown;
  promotional_balance_microusd: unknown;
  addon_balance_microusd: unknown;
  reserved_microusd: unknown;
  funding_shortfall_microusd: unknown;
  month_period_start: string;
  month_spent_microusd: unknown;
  month_reserved_microusd: unknown;
};

export function exactInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Funded AI monetary total exceeds safe integer range");
  return parsed;
}

export function usageReservationLimit(authorizationResponse: string): number | null {
  const value = JSON.parse(authorizationResponse) as { reservation?: { billingMode?: unknown; maxCostMicrousd?: unknown } };
  if (value.reservation?.billingMode !== "usage") return null;
  const limit = exactInteger(value.reservation.maxCostMicrousd);
  if (limit < 1) throw new Error("Usage reservation liability limit is invalid");
  return limit;
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseModels(value: string): string[] {
  try {
    return ModelIdsSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error("Invalid funded AI policy model configuration", { cause: error });
  }
}

export function intersectModels(globalModels: string[], runtimeModels: string[]): string[] {
  const runtimeSet = new Set(runtimeModels);
  return globalModels.filter((model) => runtimeSet.has(model));
}

export function utcMonthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

export function fundingSummary(
  balance: BalanceSnapshot,
  monthlyBudgetMicrousd: number,
  asOf: string,
): FundedAiFundingSummary {
  const creditBalanceMicrousd = exactInteger(balance.credit_balance_microusd);
  const reservedMicrousd = exactInteger(balance.reserved_microusd);
  const fundingShortfallMicrousd = exactInteger(balance.funding_shortfall_microusd);
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
    fundingShortfallMicrousd,
    remainingBalanceMicrousd: Math.max(
      0,
      creditBalanceMicrousd - reservedMicrousd - fundingShortfallMicrousd,
    ),
    remainingBudgetMicrousd: Math.max(
      0,
      monthlyBudgetMicrousd - settledThisMonthMicrousd - reservedThisMonthMicrousd,
    ),
  });
}

export async function recordUsageFunding(
  executor: PlatformDB["executor"],
  reservation: {
    reservation_id: string;
    request_id: string;
    owner_id: string;
    machine_id: string;
    runtime_slot: string;
    period_start: string;
    reserved_microusd: unknown;
  },
  actualCostMicrousd: number,
  promotionalDebitMicrousd: number,
  addonDebitMicrousd: number,
  checkedAt: string,
  matrixAbsorbsOverrun = false,
): Promise<void> {
  const reservedMicrousd = exactInteger(reservation.reserved_microusd);
  const chargedMicrousd = promotionalDebitMicrousd + addonDebitMicrousd;
  const fundingShortfallMicrousd = matrixAbsorbsOverrun ? 0 : actualCostMicrousd - chargedMicrousd;
  if (fundingShortfallMicrousd < 0) {
    throw new Error("Funded AI usage debit exceeds provider actual");
  }
  const ledgerRows = [
    promotionalDebitMicrousd > 0 ? {
      entry_id: `usage:${reservation.reservation_id}:promotional`,
      owner_id: reservation.owner_id,
      machine_id: reservation.machine_id,
      runtime_slot: reservation.runtime_slot,
      kind: "promotional_debit",
      amount_microusd: -promotionalDebitMicrousd,
      source_reference: reservation.request_id,
      reservation_id: reservation.reservation_id,
      period_start: reservation.period_start,
      expires_at: null,
      created_at: checkedAt,
    } : null,
    addonDebitMicrousd > 0 ? {
      entry_id: `usage:${reservation.reservation_id}:addon`,
      owner_id: reservation.owner_id,
      machine_id: reservation.machine_id,
      runtime_slot: reservation.runtime_slot,
      kind: "addon_debit",
      amount_microusd: -addonDebitMicrousd,
      source_reference: reservation.request_id,
      reservation_id: reservation.reservation_id,
      period_start: reservation.period_start,
      expires_at: null,
      created_at: checkedAt,
    } : null,
    fundingShortfallMicrousd > 0 ? {
      entry_id: `usage:${reservation.reservation_id}:shortfall`,
      owner_id: reservation.owner_id,
      machine_id: reservation.machine_id,
      runtime_slot: reservation.runtime_slot,
      kind: "usage_shortfall",
      amount_microusd: -fundingShortfallMicrousd,
      source_reference: reservation.request_id,
      reservation_id: reservation.reservation_id,
      period_start: reservation.period_start,
      expires_at: null,
      created_at: checkedAt,
    } : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);
  if (ledgerRows.length > 0) {
    await executor.insertInto("ai_funded_credit_ledger").values(ledgerRows).execute();
  }
  const debitedBalance = await executor.updateTable("ai_funded_runtime_balances").set({
    credit_balance_microusd: sql<number>`credit_balance_microusd - ${chargedMicrousd}`,
    promotional_balance_microusd: sql<number>`promotional_balance_microusd - ${promotionalDebitMicrousd}`,
    addon_balance_microusd: sql<number>`addon_balance_microusd - ${addonDebitMicrousd}`,
    reserved_microusd: sql<number>`reserved_microusd - ${reservedMicrousd}`,
    funding_shortfall_microusd: sql<number>`funding_shortfall_microusd + ${fundingShortfallMicrousd}`,
    month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_spent_microusd + ${matrixAbsorbsOverrun ? chargedMicrousd : actualCostMicrousd} ELSE month_spent_microusd END`,
    month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${reservation.period_start} THEN month_reserved_microusd - ${reservedMicrousd} ELSE month_reserved_microusd END`,
    updated_at: checkedAt,
  }).where("machine_id", "=", reservation.machine_id)
    .where(sql<boolean>`reserved_microusd >= ${reservedMicrousd}`)
    .where(sql<boolean>`credit_balance_microusd >= ${chargedMicrousd}`)
    .where(sql<boolean>`funding_shortfall_microusd <= ${Number.MAX_SAFE_INTEGER - fundingShortfallMicrousd}`)
    .returning("machine_id").executeTakeFirst();
  if (!debitedBalance) throw new Error("Funded AI balance invariant violated");
}
