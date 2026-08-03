"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { BillingGate } from "@/components/BillingGate";
import { BootSequence } from "@/components/BootSequence";
import { normalizeDeviceReturnPath } from "@/lib/device-onboarding";
import { navigateForOnboarding } from "@/lib/onboarding-navigation";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

function DeviceReturnHandoff({ deviceReturnPath }: { deviceReturnPath: string }) {
  useEffect(() => {
    navigateForOnboarding(deviceReturnPath);
  }, [deviceReturnPath]);

  return null;
}

/**
 * Chooses the onboarding gate (spec 092 Phase C):
 * - Device-flow returns (`device_return`, used by the CLI and native macOS app)
 *   use BillingGate until provisioning starts. The platform boot page preserves
 *   the return target, and a server-verified running shell completes the handoff
 *   back to device approval.
 * - Every other (web) entry uses the journey-driven BootSequence.
 *
 * The page.tsx cutover is intentionally conservative; the web BootSequence path
 * is validated end-to-end with a preview VPS before this gate becomes the only one.
 */
function OnboardingGateInner({
  children,
  platformSessionActive,
}: {
  children: ReactNode;
  platformSessionActive: boolean;
}) {
  const searchParams = useSearchParams();
  const rawDeviceReturnPath = searchParams.get("device_return");
  const deviceReturnPath = normalizeDeviceReturnPath(rawDeviceReturnPath);
  const isDeviceFlow = rawDeviceReturnPath !== null;
  const isBillingEntrypoint =
    searchParams.has("billing") ||
    searchParams.has("plans") ||
    searchParams.has("checkout");

  if (platformSessionActive && deviceReturnPath) {
    return <DeviceReturnHandoff deviceReturnPath={deviceReturnPath} />;
  }
  if (isDeviceFlow || isBillingEntrypoint) {
    return <BillingGate platformSessionActive={platformSessionActive}>{children}</BillingGate>;
  }
  return (
    <BootSequence platformSessionActive={platformSessionActive} e2eBypass={e2eBypass}>
      {children}
    </BootSequence>
  );
}

function OnboardingGateFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
      <output className="text-sm">Loading your Matrix computer…</output>
    </main>
  );
}

export function OnboardingGate({
  children,
  platformSessionActive = false,
}: {
  children: ReactNode;
  platformSessionActive?: boolean;
}) {
  // useSearchParams requires a Suspense boundary so the page is not forced into
  // full client-side rendering.
  return (
    <Suspense fallback={<OnboardingGateFallback />}>
      <OnboardingGateInner platformSessionActive={platformSessionActive}>
        {children}
      </OnboardingGateInner>
    </Suspense>
  );
}
