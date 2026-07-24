import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";

export const metadata: Metadata = {
  title: "Create your account | Matrix OS",
  description: "Sign up for Matrix OS. No card required until you provision a hosted Matrix computer.",
};

export default function SignUpPage() {
  return (
    <AuthLayout
      featureContent={
        <FeatureShowcase
          variant="product"
          subheading="Create your free account. Your private machine spins up only when you provision it."
        />
      }
      formContent={
        <SignUp
          forceRedirectUrl="/"
          fallbackRedirectUrl="/"
          appearance={matrixClerkAppearance}
        />
      }
    />
  );
}
