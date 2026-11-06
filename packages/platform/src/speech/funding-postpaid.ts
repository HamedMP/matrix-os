import { sql, type Selectable } from "kysely";
import type { PlatformDB, AiFundedUsageReservationsTable } from "../db.js";
import { exactInteger, recordUsageFunding, utcMonthStart } from "../ai-funded-metering-helpers.js";
import { fundingSourceAvailability, reconcileExpiredPromotionalCredit, reserveFundingSources } from "../ai-funded-reservation-sources.js";
import { readCustomerChargeRelease, releaseCustomerCharge, releaseSpeechAllowance } from "../ai-funded-customer-charge-release.js";
import { readSpeechAuthorization, SpeechSettlementReceiptSchema } from "./reservation-policy.js";
import { AiFundedPolicyError } from "../ai-funded-policy-errors.js";

type Row = Selectable<AiFundedUsageReservationsTable>;
type SourcePolicy = { promotional: boolean; addon: boolean; promotionalGrantNamespace?: "speech_monthly" };
export async function settlePostpaidSpeech(executor: PlatformDB["executor"], row: Row,
  input: { mode: "exact"; actualCostMicrousd: number } | { mode: "conservative" },
  checkedAt: string, sourcePolicy: SourcePolicy) {
  const capture = readSpeechAuthorization(row);
  if (row.status === "settled") {
    if (input.mode !== "exact" || Number(row.actual_microusd) !== input.actualCostMicrousd) throw new AiFundedPolicyError("idempotency_conflict");
    const saved = SpeechSettlementReceiptSchema.parse(JSON.parse(row.settlement_response!));
    if (row.customer_charge_release !== null) readCustomerChargeRelease(row);
    return saved;
  }
  if (row.started_at === null) throw new AiFundedPolicyError("reservation_closed");
  if (input.mode === "conservative") {
    if (row.customer_charge_release !== null) readCustomerChargeRelease(row);
    else await releaseCustomerCharge(executor, row, "usage_unknown", checkedAt);
    return;
  }
  const actual = input.actualCostMicrousd;
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > capture.maximumCostMicrousd) throw new AiFundedPolicyError("over_settlement");
  if (row.status !== "in_flight" && !(row.status === "expired" && row.customer_charge_release !== null)) throw new AiFundedPolicyError("reservation_closed");
  if (row.customer_charge_release === null && row.expires_at <= checkedAt) {
    await releaseCustomerCharge(executor, row, "expired_request", checkedAt);
    row = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", row.reservation_id).executeTakeFirstOrThrow();
  }
  let promotionalDebit = 0, addonDebit = 0;
  if (row.customer_charge_release !== null) readCustomerChargeRelease(row);
  else {
    const identity = { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot };
    const period = utcMonthStart(new Date(checkedAt));
    let budget = Number.MAX_SAFE_INTEGER;
    if (!capture.monthly) {
      const runtime = await executor.selectFrom("ai_funded_runtime_policies").select("monthly_budget_microusd")
        .where("machine_id", "=", row.machine_id).executeTakeFirstOrThrow();
      budget = exactInteger(runtime.monthly_budget_microusd);
      await executor.updateTable("ai_funded_runtime_balances").set({ month_period_start: period,
        month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${period} THEN month_spent_microusd ELSE 0 END`,
        month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${period} THEN month_reserved_microusd ELSE 0 END` })
        .where("machine_id", "=", row.machine_id).execute();
    }
    const balance = await reconcileExpiredPromotionalCredit(executor, identity, checkedAt);
    const eligibleSources = { ...sourcePolicy, promotionalGrantNamespace: capture.monthly ? "speech_monthly" as const : undefined };
    const sources = await fundingSourceAvailability(executor, identity, balance, checkedAt, eligibleSources);
    const charge = Math.max(0, Math.min(actual, sources.availableMicrousd,
      exactInteger(balance.credit_balance_microusd) - exactInteger(balance.reserved_microusd) - exactInteger(balance.funding_shortfall_microusd),
      capture.monthly ? Number.MAX_SAFE_INTEGER : budget - exactInteger(balance.month_spent_microusd) - exactInteger(balance.month_reserved_microusd)));
    const split = await reserveFundingSources(executor, identity, charge, balance, checkedAt, eligibleSources);
    for (const grant of split.grantAllocations) await executor.updateTable("ai_funded_promotional_grant_balances").set({
      remaining_microusd: sql<number>`remaining_microusd - ${grant.amountMicrousd}`, revision: sql<number>`revision + 1`, updated_at: checkedAt,
    }).where("grant_entry_id", "=", grant.grantEntryId).where("remaining_microusd", ">=", grant.amountMicrousd).returning("grant_entry_id").executeTakeFirstOrThrow();
    promotionalDebit = split.promotionalReservedMicrousd; addonDebit = split.addonReservedMicrousd;
    const quota = await releaseSpeechAllowance(executor, row, capture, checkedAt);
    if (quota.allowanceDisposition === "released") await executor.updateTable("speech_runtime_allowances").set({
      period_spent_microusd: sql<number>`period_spent_microusd + ${actual}`, updated_at: checkedAt,
    }).where("machine_id", "=", row.machine_id).where("period_start", "=", capture.allowancePeriodStart!)
      .returning("machine_id").executeTakeFirstOrThrow();
    await recordUsageFunding(executor, { ...row, reserved_microusd: 0, period_start: period }, actual,
      promotionalDebit, addonDebit, checkedAt, true, !capture.monthly);
  }
  const response = SpeechSettlementReceiptSchema.parse({ capability: "speech:transcribe", billingPolicy: "postpaid", status: "settled",
    reservationId: row.reservation_id, requestId: row.request_id, tokenId: row.token_id,
    actualCostMicrousd: actual, chargedCostMicrousd: promotionalDebit + addonDebit,
    matrixAbsorbedMicrousd: actual - promotionalDebit - addonDebit, settledAt: checkedAt });
  await executor.updateTable("ai_funded_usage_reservations").set({ status: "settled", actual_microusd: actual,
    finalization_mode: "exact", settled_at: checkedAt, settlement_response: JSON.stringify(response) })
    .where("reservation_id", "=", row.reservation_id).where("actual_microusd", "is", null)
    .where("status", "=", row.status).returning("reservation_id").executeTakeFirstOrThrow();
  return response;
}
