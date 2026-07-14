import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { resolveShellAuthRedirect } from "@/lib/auth-redirect";

export const metadata: Metadata = {
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

interface SignInPageProps {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const rawRedirect = (await searchParams).redirect_url;
  const redirectTarget = resolveShellAuthRedirect(
    Array.isArray(rawRedirect) ? rawRedirect[0] : rawRedirect,
  );

  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Come back to your computer."
      body="Sign in once and the session carries across matrix-os.com and app.matrix-os.com. If your hosted trial is not active yet, the shell opens in preview mode with billing ready inside."
    >
      <SignIn
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
