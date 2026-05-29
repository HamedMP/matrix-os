import { SignUp } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

export default function SignUpPage() {
  return (
    <ShellAuthLayout
      eyebrow="Start Matrix OS"
      title="Create the account. Open the shell."
      body="Signup stays lightweight: no card until you actually provision a hosted Matrix computer. After signup, you land in the OS and can start the trial from the native billing panel."
    >
      <SignUp
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
