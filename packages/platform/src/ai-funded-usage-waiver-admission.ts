import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { readUsageWaiverAudit, USAGE_WAIVER_MAX_RECORDS, USAGE_WAIVER_MAX_LIABILITY_MICROUSD } from "./ai-funded-usage-waiver-audit.js";

/** A status label alone cannot dispose of unknown liability. Never scan unbounded history. */
export async function readUnknownUsageWaivers(executor: PlatformDB["executor"], ownerId: string) {
  const rows = await executor.selectFrom("ai_funded_usage_reservations").selectAll()
    .where("owner_id", "=", ownerId).where((eb) => eb.or([
      eb("status", "=", "waived"),
      eb.and([eb("charge_waiver", "is not", null), eb("actual_microusd", "is", null)]),
    ])).limit(USAGE_WAIVER_MAX_RECORDS + 1).execute();
  let liabilityMicrousd = 0;
  for (const row of rows) {
    const audit = readUsageWaiverAudit(row);
    liabilityMicrousd += audit.request.reservations.find((item) => item.reservationId === row.reservation_id)!.maximumLiabilityMicrousd;
  }
  if (rows.length > USAGE_WAIVER_MAX_RECORDS || liabilityMicrousd > USAGE_WAIVER_MAX_LIABILITY_MICROUSD) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  return { rows, liabilityMicrousd };
}
