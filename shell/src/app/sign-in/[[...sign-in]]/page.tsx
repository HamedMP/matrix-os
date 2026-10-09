import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { shellAuthAppearance } from "@/components/auth/auth-brand";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

export const metadata: Metadata = {
  title: "Sign in | Matrix OS",
  description: "Sign in to your Matrix OS computer. One session carries across matrix-os.com and app.matrix-os.com.",
};

export default function SignInPage() {
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Welcome back. Make it happen."
      body="Your apps, ideas, and conversations, together in your own computer. Sign in to pick up where you left off."
    >
      <SignIn
        forceRedirectUrl="/"
        fallbackRedirectUrl="/"
        appearance={shellAuthAppearance}
      />
    </ShellAuthLayout>
  );
}
