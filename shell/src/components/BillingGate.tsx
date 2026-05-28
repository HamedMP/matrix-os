"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PricingTable, SignInButton, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { CreditCardIcon, Loader2Icon, LogInIcon } from "lucide-react";
import {
  MATRIX_BILLING_PLAN,
  getMatrixBillingSuccessRedirectUrl,
  hasMatrixBillingAccess,
} from "@/lib/billing";

const e2eBillingBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const CHECKOUT_ATTEMPT_STORAGE_KEY = "matrix.billing.checkoutAttemptAt";
const CHECKOUT_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;

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

function BillingTableFallback() {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-lg border border-border/50 bg-card/60">
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function BillingRequired() {
  return (
    <main className="min-h-screen overflow-y-auto bg-background px-4 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <section className="rounded-xl border border-border/60 bg-card/95 p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <CreditCardIcon className="size-4" aria-hidden="true" />
                <span>Matrix OS billing</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-normal">
                Choose the early adopter plan to continue
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Matrix OS is available to signed-in early adopters while the paid beta opens.
                Subscribe with Clerk Billing to unlock the shell on this account.
              </p>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              Plan: <span className="font-medium">{MATRIX_BILLING_PLAN}</span>
            </div>
          </div>
        </section>

        <section
          className="rounded-xl border border-border/60 bg-card/95 p-4 shadow-sm"
          onPointerDownCapture={rememberBillingCheckoutAttempt}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              rememberBillingCheckoutAttempt();
            }
          }}
        >
          <PricingTable
            for="user"
            newSubscriptionRedirectUrl={getMatrixBillingSuccessRedirectUrl()}
            fallback={<BillingTableFallback />}
          />
        </section>
      </div>
    </main>
  );
}

function SignInRequired() {
  return (
    <main className="min-h-screen overflow-y-auto bg-background px-4 py-10 text-foreground">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5 rounded-xl border border-border/60 bg-card/95 p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <LogInIcon className="size-4" aria-hidden="true" />
          <span>Matrix OS billing</span>
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-normal">Sign in to continue</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Matrix OS checks your Clerk account for the early adopter plan before opening
            the shell.
          </p>
        </div>
        <SignInButton mode="modal">
          <button
            type="button"
            className="inline-flex h-10 w-fit items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <LogInIcon className="size-4" aria-hidden="true" />
            Sign in
          </button>
        </SignInButton>
      </section>
    </main>
  );
}

function SubscriptionConfirmationPending() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <section className="flex w-full max-w-xl flex-col gap-4 rounded-xl border border-border/60 bg-card/95 p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          <span>Matrix OS billing</span>
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-normal">Confirming your subscription</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Clerk is updating your early adopter access. Refresh the shell in a moment if it
            does not open automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.assign(getMatrixBillingSuccessRedirectUrl())}
          className="inline-flex h-10 w-fit items-center rounded-md border border-border/60 px-4 text-sm font-medium hover:bg-muted/50"
        >
          Refresh status
        </button>
      </section>
    </main>
  );
}

export function BillingGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, has } = useAuth();
  const searchParams = useSearchParams();
  const checkoutReturnRequested = searchParams.get("checkout") === "success";
  const [checkoutJustCompleted, setCheckoutJustCompleted] = useState(false);
  const [checkoutAttemptChecked, setCheckoutAttemptChecked] = useState(false);

  useEffect(() => {
    if (!checkoutReturnRequested) {
      setCheckoutJustCompleted(false);
      setCheckoutAttemptChecked(true);
      return;
    }

    setCheckoutJustCompleted(hasRecentBillingCheckoutAttempt());
    setCheckoutAttemptChecked(true);
  }, [checkoutReturnRequested]);

  if (e2eBillingBypass) {
    return <>{children}</>;
  }

  if (!isLoaded) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Loading billing status
        </div>
      </main>
    );
  }

  if (!isSignedIn) {
    return <SignInRequired />;
  }

  const hasBillingAccess = hasMatrixBillingAccess(has);

  if (!hasBillingAccess && checkoutReturnRequested && !checkoutAttemptChecked) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Checking billing status...
        </div>
      </main>
    );
  }

  if (!hasBillingAccess) {
    if (checkoutJustCompleted) {
      return <SubscriptionConfirmationPending />;
    }

    return <BillingRequired />;
  }

  return <>{children}</>;
}
