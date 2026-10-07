import { FundedAiPriorityReasonSchema } from "@matrix-os/contracts";
import type { RuntimeAttempt } from "./funded-relay-admission.js";
import { FundedControlPlaneError } from "./funded-relay-platform-client.js";

/** Call only before generation dispatch, after any reservation release is confirmed. */
export function refundFundedCapacityAttempt(attempt: RuntimeAttempt, error: unknown): boolean {
  if (!(error instanceof FundedControlPlaneError) || error.status !== 429
    || !FundedAiPriorityReasonSchema.safeParse(error.priorityReason).success) return false;
  attempt.refund();
  return true;
}
