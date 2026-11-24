import { cleanupExpiredCustomerCharges } from "./ai-funded-customer-credit-cleanup.js";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { deleteExpiredPriorityClaims } from "./ai-funded-priority-claims.js";
import { releaseUnknownFreeHolds } from "./free-tier/prepaid-unknown-usage.js";
const MAX_EXPIRED_CLAIM_DELETES = 500;
export const CleanupSchema = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
export interface AiFundedReservationCleanupOptions { db: PlatformDB; now: () => Date }
export async function cleanupExpiredReservations(options: AiFundedReservationCleanupOptions, input: z.input<typeof CleanupSchema>): Promise<number> {
  const { limit } = CleanupSchema.parse(input);
  await options.db.ready;
  // Free prepaid holds with unknown usage are released only once their grace has passed. A failed free
  // sweep must not starve paid cleanup: it is logged, paid cleanup runs, and the failure is rethrown after.
  let released = 0;
  let freeSweepFailure: { error: unknown } | undefined;
  try {
    released = await releaseUnknownFreeHolds(options, limit);
  } catch (error: unknown) {
    console.warn("[funded-ai] Free prepaid hold sweep failed; paid cleanup continues", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    freeSweepFailure = { error };
  }
  const cleaned = released + await cleanupExpiredCustomerCharges(options, { limit });
  await deleteExpiredPriorityClaims(options.db.executor, options.now().toISOString(), MAX_EXPIRED_CLAIM_DELETES);
  if (freeSweepFailure) throw freeSweepFailure.error;
  return cleaned;
}
