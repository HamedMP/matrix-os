"use client";

import { useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/badge";
import { hasMatrixBillingAccess } from "@/lib/billing";
import { useBillingRedirectUrl } from "@/hooks/useBillingRedirectUrl";
import { BillingPanel, type BillingPanelMode } from "./BillingPanel";

export function BillingSection({
  mode = "settings",
  onCheckoutIntent,
}: {
  mode?: BillingPanelMode;
  onCheckoutIntent?: () => void;
}) {
  const { isLoaded, has } = useAuth();
  const redirectUrl = useBillingRedirectUrl();
  const active = isLoaded ? hasMatrixBillingAccess(has) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "provisioning"
              ? "Start the hosted trial from the same place you will later manage billing."
              : "Manage Matrix OS paid beta access through Clerk Billing."}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            active === true
              ? "border-forest/25 bg-forest/8 text-forest"
              : active === false
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
                : "border-border/30 bg-muted/30 text-muted-foreground"
          }
        >
          {active === true ? "Active" : active === false ? "Not active" : "Checking"}
        </Badge>
      </div>

      <BillingPanel
        active={active}
        redirectUrl={redirectUrl}
        mode={mode}
        onCheckoutIntent={onCheckoutIntent}
      />
    </div>
  );
}
