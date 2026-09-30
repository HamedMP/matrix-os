"use client";

import { useEffect, useRef } from "react";
import { z } from "zod/v4";
import type { JourneyPhase } from "@/hooks/useJourney";

export const ACCOUNT_ONLY_LANDING_TIMEOUT_MS = 3_000;
export const SHARED_WITH_ME_PATH = "/shared";

const DiscoveryPageSchema = z.object({ items: z.array(z.unknown()) });
const OrganizationListSchema = z.object({ organizations: z.array(z.unknown()) });
// Any of these means the visit is a deliberate billing, checkout or device flow.
const NON_LANDING_PARAMS = ["billing", "plans", "checkout", "handoff", "device_return"] as const;

/**
 * Spec 535 D3: an account without a computer that opens the app root on the
 * platform surface belongs on Shared with me when it already has shared work.
 * Purchase paths never redirect.
 */
export function shouldAttemptAccountOnlyLanding(input: {
  platformSurface: boolean;
  phase: JourneyPhase | undefined;
  location: { pathname: string; search: string };
}): boolean {
  if (!input.platformSurface || input.phase !== "plan_required" || input.location.pathname !== "/") return false;
  const searchParams = new URLSearchParams(input.location.search);
  return NON_LANDING_PARAMS.every((name) => !searchParams.has(name));
}

async function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) throw deadline.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    // Detaching the listener leaves `aborted` pending forever, so it never rejects unobserved.
    if (onAbort) deadline.removeEventListener("abort", onAbort);
  }
}

/**
 * One bounded probe of invitations, shares and organization membership. The
 * token lookup and all three requests share one deadline. Any failure,
 * malformed body or timeout counts as "nothing shared" so the plan screen
 * stays usable.
 */
export async function hasAccountOnlySharedWork(options: {
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? ACCOUNT_ONLY_LANDING_TIMEOUT_MS);
  let token: string | null = null;
  try {
    token = await beforeDeadline(options.getToken(), deadline);
  } catch (error: unknown) {
    console.warn("[account-only-landing] session token unavailable", error instanceof Error ? error.name : typeof error);
    // Without time left there is nothing to probe; a failed lookup still falls back to the session cookie.
    if (deadline.aborted) return false;
  }
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const probe = async (path: string, hasEntries: (body: unknown) => boolean): Promise<boolean> => {
    try {
      const response = await fetchImpl(path, {
        credentials: "same-origin",
        redirect: "error",
        headers,
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      return hasEntries(await response.json());
    } catch (error: unknown) {
      console.warn("[account-only-landing] shared work probe failed", error instanceof Error ? error.name : typeof error);
      return false;
    }
  };
  const results = await Promise.all([
    probe("/api/collaboration/inbox?limit=1", (body) => (DiscoveryPageSchema.safeParse(body).data?.items.length ?? 0) > 0),
    probe("/api/collaboration/shared?limit=1", (body) => (DiscoveryPageSchema.safeParse(body).data?.items.length ?? 0) > 0),
    probe("/api/organizations", (body) => (OrganizationListSchema.safeParse(body).data?.organizations.length ?? 0) > 0),
  ]);
  return results.some(Boolean);
}

/** Runs the landing check once per page load and replaces the location with Shared with me. */
export function useAccountOnlyLanding(input: {
  platformSurface: boolean;
  phase: JourneyPhase | undefined;
  getToken: () => Promise<string | null>;
}): void {
  const { platformSurface, phase, getToken } = input;
  // The probe is shared across effect replays (StrictMode, dependency changes), so it runs once.
  const probe = useRef<Promise<boolean> | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one bounded, timeout-guarded probe after the journey resolves to plan_required; it navigates away on success and is disposed on unmount.
  useEffect(() => {
    if (!shouldAttemptAccountOnlyLanding({ platformSurface, phase, location: window.location })) return;
    let disposed = false;
    if (!probe.current) probe.current = hasAccountOnlySharedWork({ getToken });
    void probe.current.then((found) => {
      if (found && !disposed) window.location.replace(SHARED_WITH_ME_PATH);
    });
    return () => {
      disposed = true;
    };
  }, [platformSurface, phase, getToken]);
}
