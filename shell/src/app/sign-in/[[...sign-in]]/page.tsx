import type { Metadata } from "next";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { ShellClerkAuth } from "@/components/auth/ShellClerkAuth";

export const metadata: Metadata = {
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestedReturn = (await searchParams).redirect_url;
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Come back to your computer."
      body="Sign in once and the session carries across matrix-os.com and app.matrix-os.com. If your hosted trial is not active yet, the shell opens in preview mode with billing ready inside."
    >
      <ShellClerkAuth mode="sign-in" requestedReturn={typeof requestedReturn === "string" ? requestedReturn : null} />
    </ShellAuthLayout>
  );
}
