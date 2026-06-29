import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import { getMarketingAuthRedirectUrl } from "@/inngest/provision-status";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Matrix OS account and continue to your cloud computer.",
};

export default function SignInPage() {
  return (
    <>
      <AuthLayout
        featureContent={
          <FeatureShowcase
            variant="roster"
            subheading="Welcome back. Your machine and agents are right where you left them."
          />
        }
        formContent={
          <SignIn
            forceRedirectUrl={getMarketingAuthRedirectUrl()}
            fallbackRedirectUrl={getMarketingAuthRedirectUrl()}
            appearance={matrixClerkAppearance}
          />
        }
      />
      <PostHogIdentify />
    </>
  );
}
