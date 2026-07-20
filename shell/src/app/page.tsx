import type { Metadata } from "next";
import { headers } from "next/headers";
import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";
import {
  isSignupBillingHandoffValues,
  type SignupBillingHandoffLoadingSurface,
} from "@/lib/signup-billing-handoff";

export const metadata: Metadata = {
  title: "Matrix OS",
  description: "Your AI operating system: desktop, messaging, social, and agents in one computer you own.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(await headers());
  const resolvedSearchParams = await searchParams;
  const billingValues = normalizeSearchParamValues(resolvedSearchParams.billing);
  const handoffValues = normalizeSearchParamValues(resolvedSearchParams.handoff);
  const loadingSurface: SignupBillingHandoffLoadingSurface = isSignupBillingHandoffValues(
    "/",
    billingValues,
    handoffValues,
  ) ? "signup-handoff" : "default";

  return (
    <OnboardingGate
      platformSessionActive={platformSessionActive}
      initialLoadingSurface={loadingSurface}
    >
      <ShellHome />
    </OnboardingGate>
  );
}

function normalizeSearchParamValues(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}
