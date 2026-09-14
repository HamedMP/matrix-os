"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { MatrixComputerRuntimeSlotSchema } from "@matrix-os/contracts";
import { BillingGate } from "@/components/BillingGate";
import { BootSequence } from "@/components/BootSequence";
import { MatrixLoadingScreen } from "@/components/MatrixLoadingScreen";
import { SignupBillingHandoff } from "@/components/auth/SignupBillingHandoff";
import {
  buildDeviceBootHandoffPath,
  normalizeDeviceReturnPath,
} from "@/lib/device-onboarding";
import { navigateForOnboarding } from "@/lib/onboarding-navigation";
import {
  isSignupBillingHandoffSearch,
  type SignupBillingHandoffLoadingSurface,
} from "@/lib/signup-billing-handoff";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

function DeviceReturnHandoff({ deviceReturnPath }: { deviceReturnPath: string }) {
  useEffect(() => {
    navigateForOnboarding(deviceReturnPath);
  }, [deviceReturnPath]);

  return null;
}

/**
 * Chooses the onboarding gate (spec 092 Phase C):
 * - BillingGate establishes paid access only.
 * - Device-flow returns (`device_return`, used by the CLI and native macOS app)
 *   then use the same journey-driven BootSequence as web onboarding. The
 *   server-verified running shell completes the handoff back to device approval.
 * - Every other (web) entry uses the journey-driven BootSequence directly.
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
  const rawDeviceReturnPath = searchParams.get("device_return");
  const deviceReturnPath = normalizeDeviceReturnPath(rawDeviceReturnPath);
  const isDeviceFlow = deviceReturnPath !== null;
  const parsedRuntime = MatrixComputerRuntimeSlotSchema.safeParse(searchParams.get("runtime"));
  const requestedRuntime = parsedRuntime.success ? parsedRuntime.data : null;
  const checkoutReturnRequested = searchParams.get("checkout") === "success";
  const isBillingEntrypoint =
    searchParams.has("billing") ||
    searchParams.has("plans") ||
    searchParams.has("checkout");

  if (platformSessionActive && deviceReturnPath) {
    return <DeviceReturnHandoff deviceReturnPath={deviceReturnPath} />;
  }
  if (isDeviceFlow || isBillingEntrypoint) {
    return (
      <BillingGate
        platformSessionActive={platformSessionActive}
        loadingSurface={signupBillingHandoff ? "signup-handoff" : "default"}
        handoffStartedAt={handoffStartedAt}
      >
        <BootSequence
          platformSessionActive={platformSessionActive}
          e2eBypass={e2eBypass}
          completionRedirect={
            deviceReturnPath
              ? buildDeviceBootHandoffPath(deviceReturnPath, requestedRuntime)
              : undefined
          }
          runtimeSlot={requestedRuntime}
          passivePostCheckout={isDeviceFlow || checkoutReturnRequested}
        >
          {children}
        </BootSequence>
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

  return <MatrixLoadingScreen />;
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
