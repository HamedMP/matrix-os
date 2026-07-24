import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";

export const metadata: Metadata = {
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

export default function SignInPage() {
  return (
    <AuthLayout
      featureContent={
        <FeatureShowcase
          variant="roster"
          subheading="Welcome back. Your machine and agents are right where you left them."
        />
      }
      formContent={
        <SignIn
          forceRedirectUrl="/"
          fallbackRedirectUrl="/"
          appearance={matrixClerkAppearance}
        />
      }
    />
  );
}
