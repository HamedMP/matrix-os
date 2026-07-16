import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { resolveShellAuthRedirect } from "@/lib/auth-redirect";

export const metadata: Metadata = {
  title: "Create your account | Matrix OS",
  description: "Sign up for Matrix OS. No card required until you provision a hosted Matrix computer.",
};

interface SignUpPageProps {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const rawRedirect = (await searchParams).redirect_url;
  const redirectTarget = resolveShellAuthRedirect(
    Array.isArray(rawRedirect) ? rawRedirect[0] : rawRedirect,
  );

  return (
    <ShellAuthLayout
      eyebrow="Start Matrix OS"
      title="Create the account. Open the shell."
      body="Signup stays lightweight: no card until you actually provision a hosted Matrix computer. After signup, you land in the OS and can start the trial from the native billing panel."
    >
      <SignUp
        forceRedirectUrl={redirectTarget}
        fallbackRedirectUrl={redirectTarget}
        appearance={{
          theme: shadcn,
          elements: {
            rootBox: "w-full",
            cardBox: "w-full !shadow-none !border-0",
            card: "!bg-transparent",
          },
        }}
      />
    </ShellAuthLayout>
  );
}
