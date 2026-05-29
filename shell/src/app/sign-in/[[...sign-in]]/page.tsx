import { SignIn } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

export default function SignInPage() {
  return (
    <ShellAuthLayout
      eyebrow="Matrix OS"
      title="Come back to your computer."
      body="Sign in once and the session carries across matrix-os.com and app.matrix-os.com. If your hosted trial is not active yet, the shell opens in preview mode with billing ready inside."
    >
      <SignIn
        fallbackRedirectUrl="/"
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
