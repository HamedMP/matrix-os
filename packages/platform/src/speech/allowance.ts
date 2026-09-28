import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { PlatformDB, PlatformDatabase } from "../db.js";
import { listRunningUserMachines } from "../db.js";
import { reconcileExpiredPromotionalCredit } from "../ai-funded-reservation-sources.js";

const IdentitySchema = z.object({
  ownerId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  machineId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
}).strict();
const MoneySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ConfigSchema = z.object({
  monthlyBudgetMicrousd: MoneySchema.min(1),
  monthlyPromotionalCreditMicrousd: MoneySchema,
  now: z.date(),
}).strict().refine(
  (value) => value.monthlyPromotionalCreditMicrousd <= value.monthlyBudgetMicrousd,
  "Speech promotional credit cannot exceed its monthly budget",
);

export class SpeechAllowanceError extends Error {
  constructor() {
    super("Speech allowance is unavailable");
    this.name = "SpeechAllowanceError";
  }
}

function monthBoundaries(at: Date): { periodStart: string; nextPeriodStart: string; periodKey: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return {
    periodStart: start.toISOString(),
    nextPeriodStart: next.toISOString(),
    periodKey: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

function grantEntryId(machineId: string, periodKey: string): string {
  const digest = createHash("sha256").update(machineId).digest("hex").slice(0, 40);
  return `speech-monthly:${periodKey}:${digest}`;
}

function exactInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new SpeechAllowanceError();
  return parsed;
}

export async function ensureSpeechMonthlyAllowance(
  trx: Transaction<PlatformDatabase>,
  rawIdentity: z.input<typeof IdentitySchema>,
  rawConfig: z.input<typeof ConfigSchema>,
) {
  const identity = IdentitySchema.parse(rawIdentity);
  const config = ConfigSchema.parse(rawConfig);
  const checkedAt = config.now.toISOString();
  const { periodStart, nextPeriodStart, periodKey } = monthBoundaries(config.now);
  const machine = await trx.selectFrom("user_machines").select([
    "clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at", "provisioning_class",
  ]).where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
  if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
    || machine.status !== "running" || machine.activation_state !== "authorized"
    || machine.deleted_at !== null || machine.provisioning_class !== "customer") {
    throw new SpeechAllowanceError();
  }

  await trx.insertInto("speech_runtime_allowances").values({
    machine_id: identity.machineId,
    owner_id: identity.ownerId,
    runtime_slot: identity.runtimeSlot,
    enabled: true,
    monthly_budget_microusd: config.monthlyBudgetMicrousd,
    monthly_promotional_credit_microusd: config.monthlyPromotionalCreditMicrousd,
    period_start: periodStart,
    period_spent_microusd: 0,
    period_reserved_microusd: 0,
    created_at: checkedAt,
    updated_at: checkedAt,
  }).onConflict((conflict) => conflict.column("machine_id").doUpdateSet({
    owner_id: identity.ownerId,
    runtime_slot: identity.runtimeSlot,
    enabled: true,
    monthly_budget_microusd: config.monthlyBudgetMicrousd,
    monthly_promotional_credit_microusd: config.monthlyPromotionalCreditMicrousd,
    period_start: sql<string>`CASE
      WHEN speech_runtime_allowances.period_start = ${periodStart}
      THEN speech_runtime_allowances.period_start ELSE ${periodStart} END`,
    period_spent_microusd: sql<number>`CASE
      WHEN speech_runtime_allowances.period_start = ${periodStart}
      THEN speech_runtime_allowances.period_spent_microusd ELSE 0 END`,
    period_reserved_microusd: sql<number>`CASE
      WHEN speech_runtime_allowances.period_start = ${periodStart}
      THEN speech_runtime_allowances.period_reserved_microusd ELSE 0 END`,
    updated_at: checkedAt,
  })).execute();

  const allowance = await trx.selectFrom("speech_runtime_allowances").selectAll()
    .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirstOrThrow();
  if (allowance.owner_id !== identity.ownerId || allowance.runtime_slot !== identity.runtimeSlot
    || allowance.enabled !== true
    || exactInteger(allowance.monthly_budget_microusd) !== config.monthlyBudgetMicrousd
    || exactInteger(allowance.monthly_promotional_credit_microusd)
      !== config.monthlyPromotionalCreditMicrousd) {
    throw new SpeechAllowanceError();
  }

  await trx.insertInto("ai_funded_runtime_balances").values({
    machine_id: identity.machineId,
    owner_id: identity.ownerId,
    runtime_slot: identity.runtimeSlot,
    credit_balance_microusd: 0,
    promotional_balance_microusd: 0,
    addon_balance_microusd: 0,
    reserved_microusd: 0,
    funding_shortfall_microusd: 0,
    month_period_start: periodStart,
    month_spent_microusd: 0,
    month_reserved_microusd: 0,
    updated_at: checkedAt,
  }).onConflict((conflict) => conflict.column("machine_id").doNothing()).execute();
  const balance = await trx.selectFrom("ai_funded_runtime_balances")
    .select(["owner_id", "runtime_slot"]).where("machine_id", "=", identity.machineId)
    .forUpdate().executeTakeFirstOrThrow();
  if (balance.owner_id !== identity.ownerId || balance.runtime_slot !== identity.runtimeSlot) {
    throw new SpeechAllowanceError();
  }
  await reconcileExpiredPromotionalCredit(trx, identity, checkedAt);

  if (config.monthlyPromotionalCreditMicrousd > 0) {
    const entryId = grantEntryId(identity.machineId, periodKey);
    const sourceReference = `platform-speech-monthly:${periodKey}`;
    const inserted = await trx.insertInto("ai_funded_credit_ledger").values({
      entry_id: entryId,
      owner_id: identity.ownerId,
      machine_id: identity.machineId,
      runtime_slot: identity.runtimeSlot,
      kind: "promotional_grant",
      amount_microusd: config.monthlyPromotionalCreditMicrousd,
      source_reference: sourceReference,
      reservation_id: null,
      period_start: null,
      expires_at: nextPeriodStart,
      created_at: checkedAt,
    }).onConflict((conflict) => conflict.column("entry_id").doNothing())
      .returning("entry_id").executeTakeFirst();
    const stored = await trx.selectFrom("ai_funded_credit_ledger").selectAll()
      .where("entry_id", "=", entryId).executeTakeFirstOrThrow();
    if (stored.owner_id !== identity.ownerId || stored.machine_id !== identity.machineId
      || stored.runtime_slot !== identity.runtimeSlot || stored.kind !== "promotional_grant"
      || exactInteger(stored.amount_microusd) !== config.monthlyPromotionalCreditMicrousd
      || stored.source_reference !== sourceReference || stored.reservation_id !== null
      || stored.expires_at !== nextPeriodStart) {
      throw new SpeechAllowanceError();
    }
    if (inserted) {
      await trx.insertInto("ai_funded_promotional_grant_balances").values({
        grant_entry_id: entryId,
        owner_id: identity.ownerId,
        machine_id: identity.machineId,
        runtime_slot: identity.runtimeSlot,
        remaining_microusd: config.monthlyPromotionalCreditMicrousd,
        expires_at: nextPeriodStart,
        created_at: checkedAt,
        updated_at: checkedAt,
        revision: 0,
      }).execute();
      const credited = await trx.updateTable("ai_funded_runtime_balances").set({
        credit_balance_microusd: sql<number>`credit_balance_microusd + ${config.monthlyPromotionalCreditMicrousd}`,
        promotional_balance_microusd: sql<number>`promotional_balance_microusd + ${config.monthlyPromotionalCreditMicrousd}`,
        updated_at: checkedAt,
      }).where("machine_id", "=", identity.machineId)
        .where(sql<boolean>`credit_balance_microusd <= ${Number.MAX_SAFE_INTEGER - config.monthlyPromotionalCreditMicrousd}`)
        .where(sql<boolean>`promotional_balance_microusd <= ${Number.MAX_SAFE_INTEGER - config.monthlyPromotionalCreditMicrousd}`)
        .returning("machine_id").executeTakeFirst();
      if (!credited) throw new SpeechAllowanceError();
    }
  }
  return allowance;
}

export async function reconcileSpeechMonthlyAllowances(options: {
  db: PlatformDB;
  monthlyBudgetMicrousd: number;
  monthlyPromotionalCreditMicrousd: number;
  now?: () => Date;
  limit?: number;
}): Promise<{ eligible: number; reconciled: number; failed: number }> {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid speech reconcile limit");
  const machines = await listRunningUserMachines(options.db, limit, {
    provisioningClass: "customer",
    activationState: "authorized",
  });
  let reconciled = 0;
  let failed = 0;
  for (const machine of machines) {
    try {
      await options.db.transaction((trx) => ensureSpeechMonthlyAllowance(
        trx.executor as Transaction<PlatformDatabase>, {
          ownerId: machine.clerkUserId,
          machineId: machine.machineId,
          runtimeSlot: machine.runtimeSlot,
        }, {
          monthlyBudgetMicrousd: options.monthlyBudgetMicrousd,
          monthlyPromotionalCreditMicrousd: options.monthlyPromotionalCreditMicrousd,
          now: (options.now ?? (() => new Date()))(),
        },
      ));
      reconciled += 1;
    } catch (error: unknown) {
      failed += 1;
      console.warn("[platform-speech] monthly allowance reconciliation failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return { eligible: machines.length, reconciled, failed };
}
