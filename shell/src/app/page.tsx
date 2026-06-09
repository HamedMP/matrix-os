import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { BillingGate } from "@/components/BillingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";

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

export default async function Home() {
  const platformSessionActive = hasServerVerifiedMatrixSession(await headers());

  return (
    <Suspense fallback={<BillingGateFallback />}>
      <BillingGate platformSessionActive={platformSessionActive}>
        <ShellHome />
      </BillingGate>
    </Suspense>
  );
}
