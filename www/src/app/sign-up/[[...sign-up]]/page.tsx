import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import { parsePlanUrlSlug } from "@/lib/billing-plans";
import {
  getMarketingAuthRedirectUrl,
  getSignupFallbackRedirectUrl,
} from "@/inngest/provision-status";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your Matrix OS account to get started with your cloud computer.",
};

const URL_PLAN_SLUG: Record<string, string> = {
  matrix_starter: "starter",
  matrix_builder: "builder",
  matrix_max: "max",
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawPlan = Array.isArray(params.plan) ? params.plan[0] : params.plan;
  const planSlug = parsePlanUrlSlug(rawPlan);
  // Valid plan → hand off through /welcome so we can persist the choice to
  // Clerk public metadata before the app's onboarding state machine takes over.
  const redirectUrl = planSlug
    ? `/welcome?plan=${URL_PLAN_SLUG[planSlug]}`
    : getMarketingAuthRedirectUrl();

  return (
    <>
      <AuthLayout
        featureContent={
          <FeatureShowcase
            variant="product"
            subheading="Create your free account. Your private machine spins up only when you provision it."
          />
        }
        formContent={
          <SignUp
            forceRedirectUrl={redirectUrl}
            fallbackRedirectUrl={planSlug ? redirectUrl : getSignupFallbackRedirectUrl()}
            appearance={matrixClerkAppearance}
          />
        }
      />
      <PostHogIdentify />
    </>
  );
}
