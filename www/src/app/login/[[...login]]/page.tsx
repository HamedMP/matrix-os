import { SignIn } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";
import { matrixClerkAppearance } from "@/components/auth/clerkAppearance";

export default function LoginPage() {
  return (
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
  );
}
