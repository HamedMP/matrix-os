import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <SignIn
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "bg-zinc-900 border border-zinc-800",
          },
        }}
      />
    </div>
  );
}
