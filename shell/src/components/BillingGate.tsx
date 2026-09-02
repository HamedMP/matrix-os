"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon } from "@/lib/hugeicons";
import {
  getMatrixBillingSuccessRedirectUrl,
} from "@/lib/billing";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { MatrixBootMark } from "@/components/MatrixBootMark";
import { SignupBillingHandoff } from "@/components/auth/SignupBillingHandoff";
import {
  isSignupBillingHandoffSearch,
  type SignupBillingHandoffLoadingSurface,
} from "@/lib/signup-billing-handoff";
import { AddComputerOnboarding } from "@/components/runtime/RuntimeManager";
import { Settings } from "./Settings";
import { normalizeDeviceReturnPath } from "@/lib/device-onboarding";

const e2eBillingBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const CHECKOUT_ATTEMPT_STORAGE_KEY = "matrix.billing.checkoutAttemptAt";
const CHECKOUT_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_SIGN_IN_URL = "https://matrix-os.com/login";

function logCheckoutStorageError(action: "read" | "write", error: unknown): void {
  if (error instanceof Error) {
    console.warn(`[billing] unable to ${action} checkout attempt state`, error.message);
    return;
  }

  console.warn(`[billing] unable to ${action} checkout attempt state`);
}

function rememberBillingCheckoutAttempt(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, String(Date.now()));
    capturePostHogEvent("billing_checkout_attempt_remembered", {
      surface: "shell",
      source: "billing_gate",
    });
  } catch (error) {
    logCheckoutStorageError("write", error);
  }
}

function hasRecentBillingCheckoutAttempt(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const rawAttemptAt = window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    if (!rawAttemptAt) return false;

    const attemptAt = Number(rawAttemptAt);
    return Number.isFinite(attemptAt) && Date.now() - attemptAt <= CHECKOUT_ATTEMPT_MAX_AGE_MS;
  } catch (error) {
    logCheckoutStorageError("read", error);
    return false;
  }
}

function getBillingCheckoutReturnPath(deviceReturnPath: string | null): string | undefined {
  return deviceReturnPath ?? undefined;
}

function BillingRequired({ checkoutReturnPath }: { checkoutReturnPath?: string }) {
  return (
    <Settings
      open
      onOpenChange={() => {}}
      defaultSection="billing"
      lockedSection="billing"
      billingActiveOverride={false}
      closeDisabled
      billingMode={checkoutReturnPath ? "device-setup" : "provisioning"}
      onBillingCheckoutIntent={rememberBillingCheckoutAttempt}
      billingCheckoutReturnPath={checkoutReturnPath}
    />
  );
}

function getSignInRedirectUrl(): string {
  const configuredSignInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? DEFAULT_SIGN_IN_URL;
  const currentUrl =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : "/";
  const appOrigin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://app.matrix-os.com";
  const signInUrl = new URL(configuredSignInUrl, appOrigin);
  signInUrl.searchParams.set("redirect_url", new URL(currentUrl, appOrigin).toString());
  return signInUrl.toString();
}

function SignInRedirecting() {
  useEffect(() => {
    window.location.assign(getSignInRedirectUrl());
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-page-bg px-4 text-deep">
      <section className="relative flex w-full max-w-md flex-col items-center gap-5 overflow-hidden rounded-3xl border border-forest/15 bg-white p-8 text-center shadow-[0_40px_120px_rgba(50,53,46,0.15)]">
        <div
          className="pointer-events-none absolute -right-20 -top-20 size-60 rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--ember) 22%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />
        <MatrixBootMark size={60} className="relative" />
        <div className="relative space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-deep">
            Opening Matrix OS sign in
          </h1>
          <p className="text-sm leading-6 text-forest/75">
            Redirecting to matrix-os.com so signup stays in one place.
          </p>
        </div>
      </section>
    </main>
  );
}

function SubscriptionConfirmationPending({
  status = "preparing",
  onRefresh = () => window.location.assign(getMatrixBillingSuccessRedirectUrl()),
}: {
  status?: "preparing" | "failed";
  onRefresh?: () => void;
}) {
  const failed = status === "failed";

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-deep/30 px-4 py-8 text-deep backdrop-blur-md"
      style={{ zIndex: SHELL_Z_INDEX.hardGate }}
    >
      <section className="relative flex w-full max-w-md flex-col overflow-hidden rounded-3xl border border-forest/15 bg-page-bg/95 shadow-[0_40px_120px_rgba(50,53,46,0.35)]">
        <div
          className="pointer-events-none absolute -right-20 -top-20 size-60 rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--ember) 22%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />

        <div className="relative flex flex-col items-center gap-5 p-8 text-center">
          <MatrixBootMark size={64} />
          <div className="space-y-2">
            <p className="flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">
              {failed ? (
                <AlertCircleIcon className="size-3.5 text-ember" aria-hidden="true" />
              ) : (
                <Loader2Icon className="size-3.5 animate-spin text-ember" aria-hidden="true" />
              )}
              Matrix OS · Billing
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-deep">
              {failed ? "Matrix setup needs attention" : "Confirming your subscription"}
            </h1>
            <p className="mx-auto max-w-xs text-sm leading-6 text-forest/75">
              {failed
                ? "Billing is active, but your Matrix computer did not finish starting. Try again to continue CLI login."
                : "Stripe is activating billing for your Matrix computer. This usually takes a few seconds — your shell will open automatically."}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-10 items-center rounded-xl border border-forest/15 bg-white px-5 text-sm font-semibold text-forest transition-colors hover:bg-cream/60"
          >
            {failed ? "Try again" : "Refresh status"}
          </button>
        </div>
      </section>
    </div>
  );
}

function BillingStatusLoading() {
  return (
    <main data-matrix-billing-gate="true" className="flex min-h-screen items-center justify-center bg-page-bg px-6 py-10 text-forest/70">
      <output
        className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border border-forest/15 bg-white/85 p-6 text-center shadow-[0_24px_80px_rgba(50,53,46,0.16)]"
        aria-live="polite"
      >
        <MatrixBootMark size={56} />
        <span className="flex items-center gap-2 text-sm font-medium text-forest">
          <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Loading billing status
        </span>
        <span className="max-w-xs text-sm leading-6 text-forest/70">
          Matrix is checking your subscription before opening billing setup.
        </span>
      </output>
    </main>
  );
}

export function BillingGate({
  children,
  platformSessionActive = false,
  loadingSurface = "default",
  handoffStartedAt: initialHandoffStartedAt,
}: {
  children: ReactNode;
  platformSessionActive?: boolean;
  loadingSurface?: SignupBillingHandoffLoadingSurface;
  handoffStartedAt?: number;
}) {
  const [handoffStartedAt] = useState(() => initialHandoffStartedAt ?? Date.now());
  // useSearchParams() (read inside BillingGateInner) requires a <Suspense> boundary so the page
  // is not forced into full client-side rendering; the fallback mirrors the gate's own loading
  // state so there is no visible change while search params resolve.
  return (
    <Suspense
      fallback={
        loadingSurface === "signup-handoff"
          ? <SignupBillingHandoff startedAt={handoffStartedAt} />
          : <BillingStatusLoading />
      }
    >
      <BillingGateRoute
        platformSessionActive={platformSessionActive}
        loadingSurface={loadingSurface}
        handoffStartedAt={handoffStartedAt}
      >
        {children}
      </BillingGateRoute>
    </Suspense>
  );
}

function BillingGateRoute({
  children,
  platformSessionActive,
  loadingSurface,
  handoffStartedAt,
}: {
  children: ReactNode;
  platformSessionActive: boolean;
  loadingSurface: SignupBillingHandoffLoadingSurface;
  handoffStartedAt: number;
}) {
  const searchParams = useSearchParams();
  const isAddComputerHandoff = searchParams.get("handoff") === "add-computer";

  if (isAddComputerHandoff) {
    return <AddComputerOnboarding />;
  }
  if (platformSessionActive) {
    return <>{children}</>;
  }
  return (
    <BillingGateInner
      loadingSurface={loadingSurface}
      handoffStartedAt={handoffStartedAt}
    >
      {children}
    </BillingGateInner>
  );
}

function BillingGateInner({
  children,
  loadingSurface,
  handoffStartedAt,
}: {
  children: ReactNode;
  loadingSurface: SignupBillingHandoffLoadingSurface;
  handoffStartedAt: number;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const { active: billingActive, checking: billingAccessChecking } = useMatrixBillingAccess();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const signupBillingHandoff =
    loadingSurface === "signup-handoff" &&
    isSignupBillingHandoffSearch(pathname, searchParams);
  const checkoutReturnRequested = searchParams.get("checkout") === "success";
  const deviceReturnPath = normalizeDeviceReturnPath(searchParams.get("device_return"));
  const billingCheckoutReturnPath = getBillingCheckoutReturnPath(deviceReturnPath);
  const hasBillingAccess = billingActive === true;
  const billingChecking = billingAccessChecking;
  const [checkoutJustCompleted, setCheckoutJustCompleted] = useState(false);
  const [checkoutAttemptChecked, setCheckoutAttemptChecked] = useState(false);
  const lastTrackedState = useRef<string | null>(null);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- not a cascade: this is a single post-hydration resolution of the checkout-return state. The two setStates batch in one render pass and only re-run when `checkoutReturnRequested` changes; they cannot be derived in render because hasRecentBillingCheckoutAttempt() reads sessionStorage, which is client-only and would break SSR/hydration.
  useEffect(() => {
    if (!checkoutReturnRequested) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- client-only resolution of checkout-return state: hasRecentBillingCheckoutAttempt() reads sessionStorage and must run after hydration, so it cannot be a render-time initializer.
      setCheckoutJustCompleted(false);
      setCheckoutAttemptChecked(true);
      return;
    }

    setCheckoutJustCompleted(hasRecentBillingCheckoutAttempt());
    setCheckoutAttemptChecked(true);
  }, [checkoutReturnRequested]);

  useEffect(() => {
    if (hasBillingAccess && checkoutReturnRequested && !deviceReturnPath) {
      capturePostHogEvent("billing_checkout_confirmed", {
        surface: "shell",
        source: "billing_gate",
      });
    }
  }, [checkoutReturnRequested, deviceReturnPath, hasBillingAccess]);

  useEffect(() => {
    if (!isLoaded || billingChecking) return;
    const state = hasBillingAccess
      ? "billing_active"
      : !isSignedIn
        ? "signed_out"
        : checkoutReturnRequested
          ? "checkout_return_pending"
          : "billing_required";
    if (lastTrackedState.current === state) return;
    lastTrackedState.current = state;
    capturePostHogEvent("shell_access_state_changed", {
      surface: "shell",
      source: "billing_gate",
      access_state: state,
      checkout_return_requested: checkoutReturnRequested,
    });
    capturePostHogLog("info", `shell access ${state}`, {
      surface: "shell",
      source: "billing_gate",
      access_state: state,
      checkout_return_requested: checkoutReturnRequested,
    });
  }, [billingChecking, checkoutReturnRequested, hasBillingAccess, isLoaded, isSignedIn]);

  if (e2eBillingBypass) {
    return <>{children}</>;
  }

  if (!isLoaded || billingChecking) {
    return signupBillingHandoff
      ? <SignupBillingHandoff startedAt={handoffStartedAt} />
      : <BillingStatusLoading />;
  }

  if (!isSignedIn && !hasBillingAccess) {
    return <SignInRedirecting />;
  }

  if (!hasBillingAccess && checkoutReturnRequested && !checkoutAttemptChecked) {
    return (
      <main data-matrix-billing-gate="true" className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
        <output className="flex items-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Checking billing status...
        </output>
      </main>
    );
  }

  if (!hasBillingAccess) {
    if (checkoutJustCompleted) {
      return (
        <>
          <div className="min-h-screen pointer-events-none select-none blur-[1px] brightness-90">
            {children}
          </div>
          <SubscriptionConfirmationPending />
        </>
      );
    }

    return (
      <>
        <div className="min-h-screen pointer-events-none select-none blur-[1px] brightness-90">
          {children}
        </div>
        <BillingRequired checkoutReturnPath={billingCheckoutReturnPath} />
      </>
    );
  }

  return <>{children}</>;
}
