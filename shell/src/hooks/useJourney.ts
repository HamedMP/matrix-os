"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

// Mirrors the platform GET /api/journey contract (spec 092). Kept structural so
// the shell never hard-codes provider/internal details.
export type JourneyPhase =
  | "account_required"
  | "plan_required"
  | "payment_settling"
  | "provisioning"
  | "provisioning_failed"
  | "first_run"
  | "ready";

export type JourneyActionKind =
  | "open_plans"
  | "wait"
  | "start_provision"
  | "retry_provision"
  | "contact_support"
  | "begin_first_run"
  | "open_shell"
  | "none";

export interface JourneyState {
  phase: JourneyPhase;
  detail: string;
  nextAction: { kind: JourneyActionKind; url?: string };
  progress?: { stage: string; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
  settling?: { since: string; delayed: boolean };
  readiness?: { status: "ok" | "degraded"; failing: string[] };
}

export type JourneyStatus = "loading" | "ready" | "unreachable" | "unauthorized";

export interface UseJourneyResult {
  state: JourneyState | null;
  status: JourneyStatus;
  refreshJourney: () => void;
}

const JOURNEY_TIMEOUT_MS = 10_000;
const ACTIVE_POLL_MS = 4_000;
// Phases that are still moving on the server — poll until they settle.
const ACTIVE_PHASES = new Set<JourneyPhase>(["payment_settling", "provisioning"]);

/**
 * Polls GET /api/journey for the signed-in user. Polls only while the phase is
 * still moving (settling/provisioning) and stops in terminal phases; on a 503 or
 * network failure it reports `unreachable` rather than guessing a phase. The
 * request is same-origin (proxied to the platform) and Clerk-bearer authed.
 */
export function useJourney(options: { enabled?: boolean } = {}): UseJourneyResult {
  const enabled = options.enabled ?? true;
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [state, setState] = useState<JourneyState | null>(null);
  const [status, setStatus] = useState<JourneyStatus>("loading");
  const [nonce, setNonce] = useState(0);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is consumed by the polling useEffect dependency array below and returned to callers (BootSequence effect deps); a stable refreshJourney keeps the poller from re-subscribing every render.
  const refreshJourney = useCallback(() => setNonce((n) => n + 1), []);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this hook IS the journey poller; there is no data-fetching library in the shell. Races/leaks are guarded by a per-effect disposed flag + AbortController + single-timer scheduling, and it self-stops in terminal phases.
  useEffect(() => {
    if (!enabled || !isLoaded || !isSignedIn) return;
    let disposed = false;
    let pollTimer: number | undefined;
    let inFlightController: AbortController | undefined;

    async function fetchOnce(): Promise<void> {
      const controller = new AbortController();
      inFlightController = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), JOURNEY_TIMEOUT_MS);
      // react-doctor-disable-next-line react-doctor/async-defer-await, react-hooks-js/todo -- ordered flow: the token is needed for the request that follows, and the post-await `disposed` guards discard a response received after unmount/refreshJourney, so these awaits cannot be deferred past them.
      try {
        const token = await getToken();
        if (disposed) return;
        const res = await fetch("/api/journey", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
        });
        if (disposed) return;
        if (res.status === 401 || res.status === 403) {
          // Auth no longer valid - STOP polling (do not hammer the endpoint
          // under a persistent auth failure) and let the gate re-authenticate.
          setStatus("unauthorized");
          return;
        }
        if (!res.ok) {
          // 5xx/other -> transient; cannot trust a phase, keep retrying.
          setStatus("unreachable");
          scheduleNext(ACTIVE_POLL_MS);
          return;
        }
        const body = (await res.json()) as JourneyState;
        if (disposed) return;
        setState(body);
        setStatus("ready");
        if (ACTIVE_PHASES.has(body.phase)) scheduleNext(ACTIVE_POLL_MS);
      } catch (err: unknown) {
        if (disposed) return;
        // Network/timeout/abort -> unreachable; keep trying while mounted.
        setStatus((prev) => (prev === "ready" ? prev : "unreachable"));
        scheduleNext(ACTIVE_POLL_MS);
      } finally {
        if (inFlightController === controller) inFlightController = undefined;
        window.clearTimeout(timeoutId);
      }
    }

    function scheduleNext(delayMs: number): void {
      if (disposed) return;
      pollTimer = window.setTimeout(() => {
        void fetchOnce();
      }, delayMs);
    }

    void fetchOnce();

    return () => {
      disposed = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      inFlightController?.abort();
    };
  }, [enabled, isLoaded, isSignedIn, getToken, nonce]);

  return { state, status, refreshJourney };
}
