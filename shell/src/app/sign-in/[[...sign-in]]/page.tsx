import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";
import { resolveShellAuthRedirectUrl } from "@/lib/auth-handoff";

export const metadata: Metadata = {
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ matrix_redirect_url?: string | string[] }>;
}) {
  const redirectUrl = (await searchParams).matrix_redirect_url;
  const absoluteRedirectUrl = resolveShellAuthRedirectUrl(
    Array.isArray(redirectUrl) ? redirectUrl[0] : redirectUrl,
    process.env.NEXT_PUBLIC_MATRIX_APP_URL,
  );
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Come back to your computer."
      body="Sign in once and the session carries across matrix-os.com and app.matrix-os.com. If your hosted trial is not active yet, the shell opens in preview mode with billing ready inside."
    >
      <SignIn
        forceRedirectUrl={absoluteRedirectUrl}
        fallbackRedirectUrl={absoluteRedirectUrl}
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
