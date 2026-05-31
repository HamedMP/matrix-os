import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingGate } from "@/components/BillingGate";
import { ShellHome } from "@/components/ShellHome";

export const metadata: Metadata = {
  title: "Matrix OS",
  description: "Your AI operating system: desktop, messaging, social, and agents in one computer you own.",
};

function BillingGateFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <output className="text-sm">Loading billing status</output>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<BillingGateFallback />}>
      <BillingGate>
        <ShellHome />
      </BillingGate>
    </Suspense>
  );
}
