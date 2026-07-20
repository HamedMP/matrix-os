"use client";

import { Suspense, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BillingGate } from "@/components/BillingGate";
import { BootSequence } from "@/components/BootSequence";
import { SignupBillingHandoff } from "@/components/auth/SignupBillingHandoff";
import {
  isSignupBillingHandoffSearch,
  type SignupBillingHandoffLoadingSurface,
} from "@/lib/signup-billing-handoff";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

/**
 * Chooses the onboarding gate (spec 092 Phase C):
 * - Device-flow returns (`device_return`, used by the CLI and native macOS app)
 *   keep the proven BillingGate handoff that provisions and redirects back to the
 *   approving device — unchanged to avoid regressing that flow.
 * - Every other (web) entry uses the journey-driven BootSequence.
 *
 * The page.tsx cutover is intentionally conservative; the web BootSequence path
 * is validated end-to-end with a preview VPS before this gate becomes the only one.
 */
function OnboardingGateInner({
  children,
  platformSessionActive,
  handoffStartedAt,
}: {
  children: ReactNode;
  platformSessionActive: boolean;
  handoffStartedAt: number;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const signupBillingHandoff = isSignupBillingHandoffSearch(pathname, searchParams);
  const isDeviceFlow = searchParams.get("device_return") !== null;
  const isBillingEntrypoint =
    searchParams.has("billing") ||
    searchParams.has("plans") ||
    searchParams.has("checkout");

  if (isDeviceFlow || isBillingEntrypoint) {
    const loadingSurface: SignupBillingHandoffLoadingSurface = signupBillingHandoff
      ? "signup-handoff"
      : "default";
    return (
      <BillingGate
        platformSessionActive={platformSessionActive}
        loadingSurface={loadingSurface}
        handoffStartedAt={handoffStartedAt}
      >
        {children}
      </BillingGate>
    );
  }
  return (
    <BootSequence platformSessionActive={platformSessionActive} e2eBypass={e2eBypass}>
      {children}
    </BootSequence>
  );
}

function OnboardingGateFallback({
  loadingSurface,
  handoffStartedAt,
}: {
  loadingSurface: SignupBillingHandoffLoadingSurface;
  handoffStartedAt: number;
}) {
  if (loadingSurface === "signup-handoff") {
    return <SignupBillingHandoff startedAt={handoffStartedAt} />;
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
      <output className="text-sm">Loading your Matrix computer…</output>
    </main>
  );
}

export function OnboardingGate({
  children,
  platformSessionActive = false,
  initialLoadingSurface = "default",
}: {
  children: ReactNode;
  platformSessionActive?: boolean;
  initialLoadingSurface?: SignupBillingHandoffLoadingSurface;
}) {
  const [handoffStartedAt] = useState(() => Date.now());

  // useSearchParams requires a Suspense boundary so the page is not forced into
  // full client-side rendering.
  return (
    <Suspense
      fallback={
        <OnboardingGateFallback
          loadingSurface={initialLoadingSurface}
          handoffStartedAt={handoffStartedAt}
        />
      }
    >
      <OnboardingGateInner
        platformSessionActive={platformSessionActive}
        handoffStartedAt={handoffStartedAt}
      >
        {children}
      </OnboardingGateInner>
    </Suspense>
  );
}
