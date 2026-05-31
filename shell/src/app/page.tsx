import { Suspense } from "react";
import { BillingGate } from "@/components/BillingGate";
import { ShellHome } from "@/components/ShellHome";

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
