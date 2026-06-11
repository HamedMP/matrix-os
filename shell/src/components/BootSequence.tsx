"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { AlertCircleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useJourney, type JourneyState } from "@/hooks/useJourney";

// Phases where the shell (Desktop) takes over — first-run UI is owned by Desktop,
// ready is the running shell. BootSequence only renders the billing/build steps.
const PASSTHROUGH_PHASES = new Set<JourneyState["phase"]>(["first_run", "ready"]);

const STAGE_LABEL: Record<string, string> = {
  creating_server: "Creating your server",
  booting: "Booting your computer",
  registering: "Connecting your computer",
  finalizing: "Finishing setup",
};

async function authHeaders(getToken: () => Promise<string | null>): Promise<HeadersInit> {
  const token = await getToken();
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function BootShell({ children }: { children: ReactNode }) {
  return (
    <main
      data-matrix-boot-sequence="true"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-page-bg px-6 text-center text-forest/80"
    >
      {children}
    </main>
  );
}

function Spinner() {
  return <Loader2Icon className="size-5 animate-spin text-ember" aria-hidden="true" />;
}

/**
 * Unified signup-to-ready boot sequence (spec 092 Phase C). Renders one
 * continuous flow driven by GET /api/journey: plan selection, payment settling,
 * machine build progress, and retry — then hands off to the shell once the
 * journey reaches first_run/ready. Replaces the billing wall + provisioning
 * poll. The device-flow (`device_return`) and platform-session short-circuits
 * remain the caller's responsibility during the page.tsx cutover.
 */
export function BootSequence({
  children,
  platformSessionActive = false,
  e2eBypass = false,
}: {
  children: ReactNode;
  platformSessionActive?: boolean;
  e2eBypass?: boolean;
}) {
  // Server-verified session or e2e bypass: the journey is already past billing.
  if (platformSessionActive || e2eBypass) {
    return <>{children}</>;
  }
  return <BootSequenceInner>{children}</BootSequenceInner>;
}

function BootSequenceInner({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { state, status, refetch } = useJourney({ enabled: isLoaded && isSignedIn });
  const [working, setWorking] = useState(false);
  const provisionStarted = useRef(false);

  const phase = state?.phase;

  // Auto-start provisioning once, when entitled but no machine exists yet.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- a deliberate one-time side effect (guarded by provisionStarted ref + disposed flag): when the journey reports an entitled user with no machine, kick off provisioning, then refetch. This is an effect, not user-event-driven, because it must fire on the derived journey phase, not a click.
  useEffect(() => {
    if (status !== "ready" || phase !== "provisioning") return;
    if (state?.nextAction.kind !== "start_provision" || provisionStarted.current) return;
    provisionStarted.current = true;
    let disposed = false;
    void (async () => {
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await `disposed` guard discards the result if the component unmounted during the request; it can only change during this await, so the await cannot be hoisted past it.
      try {
        const res = await fetch("/api/auth/provision-runtime", {
          method: "POST",
          credentials: "include",
          headers: await authHeaders(getToken),
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        });
        if (!disposed && !res.ok && res.status !== 409) {
          provisionStarted.current = false;
        }
      } catch (err: unknown) {
        if (!disposed) provisionStarted.current = false;
        console.warn("[boot] provision start failed", err instanceof Error ? err.name : typeof err);
      } finally {
        if (!disposed) refetch();
      }
    })();
    return () => {
      disposed = true;
    };
  }, [status, phase, state?.nextAction.kind, getToken, refetch]);

  async function retryProvision(): Promise<void> {
    setWorking(true);
    // react-doctor-disable-next-line react-doctor/async-defer-await -- the request must complete before the finally block clears `working` and refetches the journey; the await is the operation being awaited, not a deferrable guard.
    try {
      await fetch("/api/journey/retry-provision", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(getToken),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      console.warn("[boot] retry-provision failed", err instanceof Error ? err.name : typeof err);
    } finally {
      setWorking(false);
      refetch();
    }
  }

  if (!isLoaded || status === "loading") {
    return (
      <BootShell>
        <Spinner />
        <p className="text-sm">Loading your Matrix computer…</p>
      </BootShell>
    );
  }

  if (status === "unreachable") {
    return (
      <BootShell>
        <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
        <p className="text-sm">We can’t reach Matrix right now.</p>
        <button type="button" onClick={refetch} className="inline-flex items-center gap-2 rounded-md border border-forest/20 px-3 py-1.5 text-sm hover:bg-forest/5">
          <RefreshCwIcon className="size-4" aria-hidden="true" /> Try again
        </button>
      </BootShell>
    );
  }

  if (!state || PASSTHROUGH_PHASES.has(state.phase)) {
    // first_run/ready (or, defensively, no state): hand off to the shell, which
    // owns the first-run experience and the running desktop.
    return <>{children}</>;
  }

  switch (state.phase) {
    case "plan_required":
      return (
        <BootShell>
          <h1 className="text-lg font-medium text-forest">Choose your plan</h1>
          <p className="max-w-sm text-sm">{state.detail}</p>
          {state.nextAction.url ? (
            <a href={state.nextAction.url} className="rounded-md bg-ember px-4 py-2 text-sm font-medium text-white hover:opacity-90">
              View plans
            </a>
          ) : null}
        </BootShell>
      );
    case "payment_settling":
      return (
        <BootShell>
          {state.settling?.delayed ? (
            <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
          ) : (
            <Spinner />
          )}
          <h1 className="text-lg font-medium text-forest">
            {state.settling?.delayed ? "Taking longer than expected" : "Activating your subscription"}
          </h1>
          <p className="max-w-sm text-sm">{state.detail}</p>
          {state.settling?.delayed ? (
            <a href="mailto:support@matrix-os.com" className="text-sm underline">Contact support</a>
          ) : null}
        </BootShell>
      );
    case "provisioning":
      return (
        <BootShell>
          <Spinner />
          <h1 className="text-lg font-medium text-forest">Building your Matrix computer</h1>
          <p className="max-w-sm text-sm">
            {state.progress ? (STAGE_LABEL[state.progress.stage] ?? state.detail) : state.detail}
          </p>
        </BootShell>
      );
    case "provisioning_failed":
      return (
        <BootShell>
          <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
          <h1 className="text-lg font-medium text-forest">Setup needs attention</h1>
          <p className="max-w-sm text-sm">{state.detail}</p>
          {state.failure?.retryable ? (
            <button type="button" disabled={working} onClick={() => void retryProvision()} className="inline-flex items-center gap-2 rounded-md bg-ember px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60">
              {working ? <Spinner /> : <RefreshCwIcon className="size-4" aria-hidden="true" />} Retry setup
            </button>
          ) : (
            <a href="mailto:support@matrix-os.com" className="text-sm underline">Contact support</a>
          )}
        </BootShell>
      );
    default:
      return <>{children}</>;
  }
}
