"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2Icon, LogInIcon } from "lucide-react";
import {
  getMatrixBillingSuccessRedirectUrl,
} from "@/lib/billing";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { Settings } from "./Settings";

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

function BillingRequired() {
  return (
    <Settings
      open
      onOpenChange={() => {}}
      defaultSection="billing"
      lockedSection="billing"
      billingActiveOverride={false}
      closeDisabled
      billingMode="provisioning"
      onBillingCheckoutIntent={rememberBillingCheckoutAttempt}
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
        <div className="relative flex size-14 items-center justify-center rounded-2xl border border-forest/15 bg-cream/50 shadow-sm">
          <LogInIcon className="size-6 text-ember" aria-hidden="true" />
        </div>
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

function SubscriptionConfirmationPending() {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-deep/30 px-4 py-8 text-deep backdrop-blur-md">
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
          <div className="flex size-14 items-center justify-center rounded-2xl border border-forest/15 bg-white shadow-sm">
            <Loader2Icon className="size-6 animate-spin text-ember" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">
              Matrix OS · Billing
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-deep">
              Confirming your subscription
            </h1>
            <p className="mx-auto max-w-xs text-sm leading-6 text-forest/75">
              Stripe is activating billing for your Matrix computer. This usually takes a few
              seconds — your shell will open automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.assign(getMatrixBillingSuccessRedirectUrl())}
            className="inline-flex h-10 items-center rounded-xl border border-forest/15 bg-white px-5 text-sm font-semibold text-forest transition-colors hover:bg-cream/60"
          >
            Refresh status
          </button>
        </div>
      </section>
    </div>
  );
}

export function BillingGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { active: billingActive } = useMatrixBillingAccess();
  const router = useRouter();
  const searchParams = useSearchParams();
  const checkoutReturnRequested = searchParams.get("checkout") === "success";
  const hasBillingAccess = isSignedIn ? billingActive === true : false;
  const billingChecking = isSignedIn && billingActive === null;
  const [checkoutJustCompleted, setCheckoutJustCompleted] = useState(false);
  const [checkoutAttemptChecked, setCheckoutAttemptChecked] = useState(false);
  const lastTrackedState = useRef<string | null>(null);

  useEffect(() => {
    if (!checkoutReturnRequested) {
      setCheckoutJustCompleted(false);
      setCheckoutAttemptChecked(true);
      return;
    }

    setCheckoutJustCompleted(hasRecentBillingCheckoutAttempt());
    setCheckoutAttemptChecked(true);
  }, [checkoutReturnRequested]);

  useEffect(() => {
    if (hasBillingAccess && checkoutReturnRequested) {
      capturePostHogEvent("billing_checkout_confirmed", {
        surface: "shell",
        source: "billing_gate",
      });
      router.replace("/");
    }
  }, [checkoutReturnRequested, hasBillingAccess, router]);

  useEffect(() => {
    if (!isLoaded) return;
    const state = !isSignedIn
      ? "signed_out"
      : hasBillingAccess
        ? "billing_active"
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
  }, [checkoutReturnRequested, hasBillingAccess, isLoaded, isSignedIn]);

  if (e2eBillingBypass) {
    return <>{children}</>;
  }

  if (!isLoaded || billingChecking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
        <div className="flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Loading billing status
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return <SignInRedirecting />;
  }

  if (!hasBillingAccess && checkoutReturnRequested && !checkoutAttemptChecked) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
        <div className="flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Checking billing status...
        </div>
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
        <BillingRequired />
      </>
    );
  }

  return <>{children}</>;
}
