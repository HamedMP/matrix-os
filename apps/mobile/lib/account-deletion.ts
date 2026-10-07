import {
  AccountDeletionRequestError,
  type AccountDeletionStatus,
} from "@/lib/requests/account-deletion";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

/** Apple's steps for removing an app from "Sign in with Apple". */
export const APPLE_ACCESS_REMOVAL_URL = "https://support.apple.com/102571";
export const MATRIX_COMPUTERS_URL = `${HOSTED_GATEWAY_URL}/runtime`;

/**
 * `cancel_awaiting_billing` is a cancellation attempted while the server still
 * reports billing as not stopped; the server refuses those until it has.
 */
export type AccountDeletionAction = "load" | "schedule" | "cancel" | "cancel_awaiting_billing" | "export";

const REQUEST_FAILED = "Your request could not be completed. Try again in a moment.";

const UNAVAILABLE: Record<AccountDeletionAction, string> = {
  load: "Account deletion is unavailable right now. Try again in a moment.",
  schedule: REQUEST_FAILED,
  cancel: REQUEST_FAILED,
  cancel_awaiting_billing: REQUEST_FAILED,
  export: "Your data could not be loaded. Try again in a moment.",
};

const CONFLICT: Partial<Record<AccountDeletionAction, string>> = {
  cancel: "Deletion has already started, so it can no longer be cancelled.",
  cancel_awaiting_billing: "Deletion can’t be cancelled until billing has stopped. Try again shortly.",
  export: "Your data is no longer available for download.",
};

/**
 * Screen copy for a failed account request. Chosen here from the failure
 * reason, so nothing the server or the network layer said is ever displayed.
 */
export function describeAccountDeletionFailure(error: unknown, action: AccountDeletionAction): string {
  const reason = error instanceof AccountDeletionRequestError ? error.reason : "unavailable";
  if (reason === "ownership_transfer_required") {
    return "Transfer ownership of your organizations and shared projects before deleting your account.";
  }
  if (reason === "conflict") return CONFLICT[action] ?? UNAVAILABLE[action];
  return UNAVAILABLE[action];
}

/** True while the request can still be cancelled and data can still be downloaded. */
export function isDeletionScheduled(status: AccountDeletionStatus | undefined): boolean {
  return status?.status === "scheduled";
}

/** True once erasure has begun: nothing can be downloaded or cancelled any more. */
export function isDeletionClosed(status: AccountDeletionStatus | undefined): boolean {
  return status?.status === "processing" || status?.status === "completed";
}

/**
 * When erasure begins, in the device's locale and time zone. Null when the
 * server sent no usable deadline, so callers fall back to copy without a date.
 */
export function formatDeletionDeadline(
  status: Pick<AccountDeletionStatus, "erasesAfter" | "completesBy">,
  detail: "date" | "date-time" = "date-time",
): string | null {
  const value = status.erasesAfter ?? status.completesBy;
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(detail === "date-time" ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}
