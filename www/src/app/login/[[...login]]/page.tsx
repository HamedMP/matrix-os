import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn
        appearance={{
          elements: {
            rootBox: "mx-auto",
            card: "bg-card rounded-xl shadow-lg border border-border",
            headerTitle: "text-foreground",
            headerSubtitle: "text-muted-foreground",
            formButtonPrimary: "bg-primary hover:bg-primary/90",
            footerActionLink: "text-primary hover:text-primary/80",
          },
        }}
      />
    </div>
  );
}
