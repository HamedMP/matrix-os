import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { shellAuthAppearance } from "@/components/auth/auth-brand";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

export const metadata: Metadata = {
  title: "Create your account | Matrix OS",
  description: "Sign up for Matrix OS. No card required until you provision a hosted Matrix computer.",
};

export default function SignUpPage() {
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="A computer that works with you."
      body="Bring your tools together, build useful apps, and make space for what matters. Start with your Matrix account."
    >
      <SignUp
        forceRedirectUrl="/"
        fallbackRedirectUrl="/"
        appearance={shellAuthAppearance}
      />
    </ShellAuthLayout>
  );
}
