import { slackLinkReturnTarget } from "../../../../../packages/platform/src/slack/link-return";
import { gmailSignInReturnTarget } from "../../../../../packages/platform/src/gmail-sign-in-return";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { shellAuthAppearance } from "@/components/auth/auth-brand";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { clerkSatelliteReturnTarget } from "@/lib/clerk-satellite-return";

export const metadata: Metadata = {
  robots: { index: false, follow: true },
  alternates: { canonical: "https://app.matrix-os.com/sign-in" },
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Self-hosted computers are gated by the local reverse proxy and render without
  // ClerkProvider, so there is no Matrix account to sign in to.
  if (process.env.MATRIX_SELF_HOSTED === "1") redirect("/");
  const params = await searchParams;
  // Only exact allowlisted return addresses survive; everything else lands on "/".
  const returnTarget =
    gmailSignInReturnTarget(params.redirect_url) ?? slackLinkReturnTarget(params.redirect_url) ?? clerkSatelliteReturnTarget(params.redirect_url) ?? "/";
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Welcome back. Make it happen."
      body="Your apps, ideas, and conversations, together in your own computer. Sign in to pick up where you left off."
    >
      <SignIn
        forceRedirectUrl={returnTarget}
        fallbackRedirectUrl={returnTarget}
        appearance={shellAuthAppearance}
      />
    </ShellAuthLayout>
  );
}
