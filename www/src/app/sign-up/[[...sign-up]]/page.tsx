import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import {
  getMarketingAuthRedirectUrl,
  getSignupFallbackRedirectUrl,
} from "@/inngest/provision-status";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create your Matrix OS account to get started with your cloud computer.",
};

export default function SignUpPage() {
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
            forceRedirectUrl={getMarketingAuthRedirectUrl()}
            fallbackRedirectUrl={getSignupFallbackRedirectUrl()}
            appearance={matrixClerkAppearance}
          />
        }
      />
      <PostHogIdentify />
    </>
  );
}
