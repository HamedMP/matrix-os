import { FundedAiSettlementResponseSchema } from "@matrix-os/contracts";
import { sql } from "kysely";
import { z } from "zod/v4";
import type { AiFundedMeteringRepositoryOptions } from "./ai-funded-metering-repository.js";
import { exactInteger, utcMonthStart, fundingSummary, recordUsageFunding } from "./ai-funded-metering-helpers.js";
import { reconcileExpiredPromotionalCredit, reservationDebitSplit, debitAttributedPromotionalGrants, debitPromotionalGrants } from "./ai-funded-reservation-sources.js";
export const CleanupSchema = z.object({ limit: z.number().int().min(1).max(1_000) }).strict();

export async function cleanupExpiredReservations(options: AiFundedMeteringRepositoryOptions, input: z.input<typeof CleanupSchema>): Promise<number> {
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
        // In-flight usage has no safe guessed charge. Keep it active and owner-
        // blocking until exact reconciliation; do not let it starve cleanup.
        .where(sql<boolean>`NOT (status = 'in_flight' AND coalesce(authorization_response::jsonb #>> '{reservation,billingMode}', '') = 'usage')`)
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
