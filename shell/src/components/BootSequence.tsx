"use client";

import { useState, type ReactNode } from "react";
import { useAuth, RedirectToSignIn } from "@clerk/nextjs";
import { palette as c, fonts, lightFg } from "@matrix-os/brand";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDollarSignIcon,
  Loader2Icon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { useJourney, type JourneyState } from "@/hooks/useJourney";
import { MatrixBootMark } from "@/components/MatrixBootMark";
import {
  PROVISIONING_RETRY_ERROR,
  isAcceptedProvisionResponse,
} from "@/lib/provisioning-handoff";
import type { DeveloperToolId } from "@/components/onboarding/developer-tools";
import { Settings } from "@/components/Settings";
import { navigateForOnboarding } from "@/lib/onboarding-navigation";

// Phases where the shell (Desktop) takes over — first-run UI is owned by Desktop,
// ready is the running shell. BootSequence only renders the billing/build steps.
const PASSTHROUGH_PHASES = new Set<JourneyState["phase"]>(["first_run", "ready"]);

const STAGE_LABEL: Record<string, string> = {
  creating_server: "Creating your server",
  booting: "Booting your computer",
  registering: "Connecting your computer",
  finalizing: "Finishing setup",
};

type BootStep = "account" | "billing" | "installs" | "computer";

const STEP_ORDER: BootStep[] = ["account", "billing", "installs", "computer"];
const STEP_LABEL: Record<BootStep, string> = {
  account: "Account",
  billing: "Billing",
  installs: "Installs",
  computer: "Computer",
};
const STEP_ICON: Record<BootStep, typeof CheckCircle2Icon> = {
  account: CheckCircle2Icon,
  billing: CircleDollarSignIcon,
  installs: CheckCircle2Icon,
  computer: ServerIcon,
};

function getStepState(step: BootStep, activeStep: BootStep): "done" | "active" | "pending" {
  const stepIndex = STEP_ORDER.indexOf(step);
  const activeIndex = STEP_ORDER.indexOf(activeStep);
  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";
  return "pending";
}

async function authHeaders(getToken: () => Promise<string | null>): Promise<HeadersInit> {
  const token = await getToken();
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function BootShell({
  children,
  activeStep = "account",
}: {
  children: ReactNode;
  activeStep?: BootStep;
}) {
  return (
    <main
      data-matrix-boot-sequence="true"
      className="flex min-h-screen flex-col items-center justify-center bg-page-bg px-6 py-10 text-center text-forest/80"
    >
      <section
        className="flex w-full max-w-5xl flex-col items-center gap-6 rounded-lg border border-forest/15 bg-white/85 p-6 shadow-[0_24px_80px_rgba(50,53,46,0.16)]"
        aria-live="polite"
      >
        <MatrixBootMark size={60} />
        <div className="flex w-full flex-wrap items-center justify-center gap-2 text-xs font-medium text-forest/70">
          {STEP_ORDER.map((step, index) => {
            const state = getStepState(step, activeStep);
            const Icon = STEP_ICON[step];
            return (
              <div key={step} className="flex min-w-0 items-center gap-2">
                {index > 0 ? <span className="hidden h-px w-5 bg-forest/15 sm:inline-block" aria-hidden="true" /> : null}
                <span
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                    state === "active"
                      ? "border-ember/35 bg-ember/10 text-deep"
                      : state === "done"
                        ? "border-forest/15 bg-cream/60 text-forest"
                        : "border-forest/10 bg-white text-forest/50",
                  ].join(" ")}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span>{STEP_LABEL[step]}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col items-center gap-4">{children}</div>
      </section>
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
  const { state, status, refreshJourney } = useJourney({ enabled: isLoaded && isSignedIn });
  const [working, setWorking] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  async function startProvision(developerTools: DeveloperToolId[]): Promise<void> {
    setWorking(true);
    setInstallError(null);
    const finishProvision = (error: string | null = null): void => {
      setWorking(false);
      setInstallError(error);
    };
    try {
      const res = await fetch("/api/auth/provision-runtime", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(getToken),
        body: JSON.stringify({ developerTools }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 402) {
        finishProvision();
        refreshJourney();
        return;
      }
      if (!await isAcceptedProvisionResponse(res)) {
        finishProvision(PROVISIONING_RETRY_ERROR);
        return;
      }
      const sessionResponse = await fetch("/api/auth/app-session", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(getToken),
        body: JSON.stringify({ redirectTo: "/" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!sessionResponse.ok) {
        finishProvision(PROVISIONING_RETRY_ERROR);
        return;
      }
      navigateForOnboarding("/");
      finishProvision();
    } catch (err: unknown) {
      console.warn("[boot] provision start failed", err instanceof Error ? err.name : typeof err);
      finishProvision(PROVISIONING_RETRY_ERROR);
    }
  }

  async function retryProvision(): Promise<void> {
    setWorking(true);
    // react-doctor-disable-next-line react-doctor/async-defer-await -- the request must complete before clearing `working` and refreshing the journey; the await is the operation being awaited, not a deferrable guard.
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
    }
    setWorking(false);
    refreshJourney();
  }

  if (!isLoaded) {
    return (
      <BootShell activeStep="account">
        <Spinner />
        <h1 className="text-lg font-medium text-forest">Checking your session</h1>
        <p className="max-w-sm text-sm">Matrix is loading your account before opening billing or your computer.</p>
      </BootShell>
    );
  }

  // Signed-out / session-expired: the journey hook is disabled, so without this
  // branch the user would spin forever. Send them to the sign-in door.
  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  if (status === "loading") {
    return (
      <BootShell activeStep="account">
        <Spinner />
        <h1 className="text-lg font-medium text-forest">Checking setup status</h1>
        <p className="max-w-sm text-sm">Matrix is checking account, billing, and computer readiness.</p>
      </BootShell>
    );
  }

  // Journey said the session is no longer valid — re-authenticate rather than
  // showing a dead retry loop.
  if (status === "unauthorized") {
    return <RedirectToSignIn />;
  }

  if (status === "unreachable") {
    return (
      <BootShell activeStep="account">
        <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
        <p className="text-sm">We can’t reach Matrix right now.</p>
        <button type="button" onClick={refreshJourney} className="inline-flex items-center gap-2 rounded-md border border-forest/20 px-3 py-1.5 text-sm hover:bg-forest/5">
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
        <BootShell activeStep="billing">
          <h1 className="text-lg font-medium text-forest" style={{ fontFamily: fonts.display }}>Choose your plan</h1>
          <p className="max-w-sm text-sm">{state.detail}</p>
          {state.nextAction.url ? (
            <a
              href={state.nextAction.url}
              className="rounded-md text-sm font-medium hover:opacity-90"
              style={{ backgroundColor: c.deep, color: lightFg, padding: "0.5rem 1rem" }}
            >
              View plans
            </a>
          ) : null}
        </BootShell>
      );
    case "payment_settling":
      return (
        <BootShell activeStep="billing">
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
    case "install_choices_required":
      return (
        <Settings
          open
          onOpenChange={() => {}}
          closeDisabled
          billingActiveOverride
          onboardingDefaultInstalls={{
            loading: working,
            error: installError,
            onBuild: (tools) => {
              void startProvision(tools);
            },
          }}
        />
      );
    case "provisioning":
      return (
        <BootShell activeStep="computer">
          <Spinner />
          <h1 className="text-lg font-medium text-forest">Building your Matrix computer</h1>
          <p className="max-w-sm text-sm">
            {state.progress ? (STAGE_LABEL[state.progress.stage] ?? state.detail) : state.detail}
          </p>
        </BootShell>
      );
    case "provisioning_failed":
      return (
        <BootShell activeStep="computer">
          <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
          <h1 className="text-lg font-medium text-forest" style={{ fontFamily: fonts.display }}>Setup needs attention</h1>
          <p className="max-w-sm text-sm">{state.detail}</p>
          {state.failure?.retryable ? (
            <button
              type="button"
              disabled={working}
              onClick={() => void retryProvision()}
              className="inline-flex items-center gap-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-60"
              style={{ backgroundColor: c.deep, color: lightFg, padding: "0.5rem 1rem" }}
            >
              {working ? <Spinner /> : <RefreshCwIcon className="size-4" aria-hidden="true" />} Retry setup
            </button>
          ) : (
            <a href="mailto:support@matrix-os.com" className="text-sm underline">Contact support</a>
          )}
        </BootShell>
      );
    case "account_required":
      return (
        <BootShell activeStep="account">
          <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
          <h1 className="text-lg font-medium text-forest">Finishing account setup</h1>
          <p className="max-w-sm text-sm">{state.detail || "We are finishing your Matrix account setup."}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={refreshJourney} className="inline-flex items-center gap-2 rounded-md border border-forest/20 px-3 py-1.5 text-sm hover:bg-forest/5">
              <RefreshCwIcon className="size-4" aria-hidden="true" /> Try again
            </button>
            <a href="mailto:support@matrix-os.com" className="text-sm underline">Contact support</a>
          </div>
        </BootShell>
      );
    default:
      // Unknown phase: do NOT fall through to the shell. Show a safe wait state.
      return (
        <BootShell activeStep="account">
          <Spinner />
          <p className="text-sm">Checking setup status…</p>
        </BootShell>
      );
  }
}
