// Mobile consumer of the platform journey contract (spec 092). The app renders
// the user's onboarding phase instead of assuming a running machine exists.

export type JourneyPhase =
  | "account_required"
  | "plan_required"
  | "payment_settling"
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
  creating_server: "Creating your server",
  booting: "Booting your computer",
  registering: "Connecting your computer",
  finalizing: "Finishing setup",
};
