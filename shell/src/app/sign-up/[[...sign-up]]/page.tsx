import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { shellAuthAppearance } from "@/components/auth/auth-brand";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { clerkSatelliteReturnTarget } from "@/lib/clerk-satellite-return";

export const metadata: Metadata = {
  robots: { index: false, follow: true },
  alternates: { canonical: "https://app.matrix-os.com/sign-up" },
  title: "Create your account | Matrix OS",
  description: "Sign up for Matrix OS. No card required until you provision a hosted Matrix computer.",
};

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Self-hosted computers are gated by the local reverse proxy and render without
  // ClerkProvider, so there is no Matrix account to sign in to.
  if (process.env.MATRIX_SELF_HOSTED === "1") redirect("/");
  const params = await searchParams;
  // A new account from a Clerk satellite goes straight back to it; nothing else leaves the app.
  const returnTarget = clerkSatelliteReturnTarget(params.redirect_url) ?? "/";
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="A computer that works with you."
      body="Bring your tools together, build useful apps, and make space for what matters. Start with your Matrix account."
    >
      <SignUp
        forceRedirectUrl={returnTarget}
        fallbackRedirectUrl={returnTarget}
        appearance={shellAuthAppearance}
      />
    </ShellAuthLayout>
  );
}
