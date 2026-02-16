import { SignUp } from "@clerk/nextjs";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";

export default function SignUpPage() {
  return (
    <AuthLayout
      featureContent={
        <FeatureShowcase
          heading="The OS that builds itself"
          subheading="Sign up to get your personal Matrix OS instance."
        />
      }
      formContent={
        <SignUp
          fallbackRedirectUrl="/dashboard"
          appearance={{
            elements: {
              rootBox: "w-full",
              card: "bg-transparent shadow-none border-0 w-full p-0",
              headerTitle: "text-foreground text-xl",
              headerSubtitle: "text-muted-foreground",
              formButtonPrimary:
                "bg-primary hover:bg-primary/90 text-primary-foreground",
              formFieldInput:
                "bg-background border-border text-foreground focus:ring-ring",
              footerActionLink: "text-primary hover:text-primary/80",
              socialButtonsBlockButton:
                "border-border text-foreground hover:bg-secondary",
              dividerLine: "bg-border",
              dividerText: "text-muted-foreground",
            },
          }}
        />
      }
    />
  );
}
