import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import { getSignupFallbackRedirectUrl } from "@/inngest/provision-status";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your Matrix OS account to get started with your cloud computer.",
};

export default function SignUpPage() {
  return (
    <AuthLayout
      featureContent={
        <FeatureShowcase
          heading="Start with a free account"
          subheading="Create your Matrix identity first. The 3-day hosted trial starts only when you provision a cloud computer."
        />
      }
      formContent={
        <SignUp
          fallbackRedirectUrl={getSignupFallbackRedirectUrl()}
          appearance={matrixClerkAppearance}
        />
      }
    />
  );
}
