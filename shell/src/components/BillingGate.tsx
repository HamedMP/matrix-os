"use client";

import type { ReactNode } from "react";
import { PricingTable, useAuth } from "@clerk/nextjs";
import { CreditCardIcon, Loader2Icon } from "lucide-react";
import {
  MATRIX_BILLING_PLAN,
  MATRIX_BILLING_RETURN_PATH,
  hasMatrixBillingAccess,
} from "@/lib/billing";

const e2eBillingBypass =
  process.env.NODE_ENV === "test" && process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

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

        <section className="rounded-xl border border-border/60 bg-card/95 p-4 shadow-sm">
          <PricingTable
            for="user"
            newSubscriptionRedirectUrl={MATRIX_BILLING_RETURN_PATH}
            fallback={<BillingTableFallback />}
          />
        </section>
      </div>
    </main>
  );
}

export function BillingGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, has } = useAuth();

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

  if (!isSignedIn || !hasMatrixBillingAccess(has)) {
    return <BillingRequired />;
  }

  return <>{children}</>;
}
