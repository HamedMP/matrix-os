import type { Metadata } from "next";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { ShellClerkAuth } from "@/components/auth/ShellClerkAuth";

export const metadata: Metadata = {
  title: "Create your account | Matrix OS",
  description: "Sign up for Matrix OS. No card required until you provision a hosted Matrix computer.",
};

export default async function SignUpPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestedReturn = (await searchParams).redirect_url;
  return (
    <ShellAuthLayout
      eyebrow="Start Matrix OS"
      title="Create the account. Open the shell."
      body="Signup stays lightweight: no card until you actually provision a hosted Matrix computer. After signup, you land in the OS and can start the trial from the native billing panel."
    >
      <ShellClerkAuth mode="sign-up" requestedReturn={typeof requestedReturn === "string" ? requestedReturn : null} />
    </ShellAuthLayout>
  );
}
