// Mobile consumer of the platform journey contract (spec 092). The app renders
// the user's onboarding phase instead of assuming a running machine exists.
import { FREE_CAPACITY_FULL_CODE, FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";

export type JourneyPhase =
  | "account_required"
  | "plan_required"
  | "payment_settling"
  | "install_choices_required"
  | "provisioning"
  | "provisioning_failed"
  | "first_run"
  | "ready";

export interface MobileJourneyState {
  phase: JourneyPhase;
  detail: string;
  nextAction: { kind: string; url?: string };
  progress?: { stage: string; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
  settling?: { since: string; delayed: boolean };
}

export type JourneyFetchResult =
  | { status: "ok"; journey: MobileJourneyState }
  | { status: "unauthorized" }
  | { status: "unreachable" };

const JOURNEY_TIMEOUT_MS = 10_000;

/**
 * Fetches the caller's journey state. Distinguishes auth failure (401/403 →
 * re-sign-in) from transient unreachability so the gate can react correctly.
 */
export async function fetchMobileJourney(baseUrl: string, token: string | null): Promise<JourneyFetchResult> {
  if (!token) return { status: "unauthorized" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOURNEY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/journey`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    if (!res.ok) return { status: "unreachable" };
    return { status: "ok", journey: (await res.json()) as MobileJourneyState };
  } catch (err: unknown) {
    // Timeouts/aborts (DOMException) and network drops (TypeError) are expected
    // and surface as `unreachable` (the gate offers retry). Log anything else.
    if (!(err instanceof DOMException) && !(err instanceof TypeError)) {
      console.warn(`[matrix] unexpected journey fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { status: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Phases where the app should hand off to the connected shell experience. */
export function isConnectablePhase(phase: JourneyPhase): boolean {
  return phase === "first_run" || phase === "ready";
}

export const PROVISIONING_STAGE_LABEL: Record<string, string> = {
  creating_server: "Creating your Matrix computer",
  booting: "Booting your computer",
  registering: "Connecting your computer",
  finalizing: "Finishing setup",
};

/**
 * Fixed copy for a build start the platform did not accept. The server's
 * error text never reaches the screen; only these strings do.
 */
export const PROVISION_START_MESSAGES = {
  unavailable: "Matrix can’t start new computers right now. Try again in a few minutes.",
  capacityFull: FREE_PLAN_COPY.capacityFull,
  throttled: "Setup was just tried. Wait a moment, then try again.",
  support: "Setup can’t continue on its own. Contact support@matrix-os.com.",
  deletionPending: "This account is being deleted, so a new computer can’t be set up.",
  unreachable: "We couldn’t reach Matrix. Check your connection and try again.",
  generic: "Setup couldn’t start. Try again.",
} as const;

const PROVISION_START_TIMEOUT_MS = 10_000;

/** Reads the response's error code for comparison against known codes only; it is never displayed. */
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
    return null;
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) {
      console.warn("[matrix] provision start response unreadable", err instanceof Error ? err.name : typeof err);
    }
    return null;
  }
}

function provisionStartErrorMessage(status: number, code: string | null): string | null {
  // Session and plan problems are the journey's to show after the reload.
  if (status === 401 || status === 402 || status === 403) return null;
  if (status === 503 && code === FREE_CAPACITY_FULL_CODE) return PROVISION_START_MESSAGES.capacityFull;
  if (status === 503) return PROVISION_START_MESSAGES.unavailable;
  if (status === 429) return PROVISION_START_MESSAGES.throttled;
  if (status === 409 && (code === "support_required" || code === "retry_exhausted")) return PROVISION_START_MESSAGES.support;
  if (status === 409 && code === "account_deletion_pending") return PROVISION_START_MESSAGES.deletionPending;
  return PROVISION_START_MESSAGES.generic;
}

/**
 * Asks the platform to start (or retry) the caller's build. Returns a fixed,
 * user-safe message when the start was not accepted, or null when there is
 * nothing to explain (accepted, or a state the journey reload will show).
 */
export async function requestMobileProvisionStart(baseUrl: string, token: string | null): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/journey/retry-provision`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(PROVISION_START_TIMEOUT_MS),
    });
    if (res.ok) return null;
    return provisionStartErrorMessage(res.status, await readErrorCode(res));
  } catch (err: unknown) {
    console.warn("[matrix] provision start failed", err instanceof Error ? err.name : typeof err);
    return PROVISION_START_MESSAGES.unreachable;
  }
}
