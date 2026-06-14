import type { Metadata } from "next";
import { ClerkProvider, SignIn } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";
import { PostHogIdentify } from "@/components/PostHogIdentify";

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to your Matrix OS account and continue to your cloud computer.",
};

export default function LoginPage() {
  return (
    <ClerkProvider>
      <AuthLayout
        featureContent={
          <FeatureShowcase
            heading="Welcome back"
            subheading="Sign in to your Matrix account, then continue to your cloud computer when it is provisioned."
          />
        }
        formContent={
          <SignIn
            fallbackRedirectUrl="/dashboard"
            appearance={matrixClerkAppearance}
          />
        }
      />
      <PostHogIdentify />
    </ClerkProvider>
  );
}
