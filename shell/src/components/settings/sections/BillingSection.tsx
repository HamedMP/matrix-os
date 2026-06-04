"use client";

import { Badge } from "@/components/ui/badge";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { BillingPanel, type BillingPanelMode } from "./BillingPanel";

export function BillingSection({
  mode = "settings",
  onCheckoutIntent,
  checkoutReturnPath,
}: {
  mode?: BillingPanelMode;
  onCheckoutIntent?: () => void;
  checkoutReturnPath?: string;
}) {
  const { active, entitlement, accessReason } = useMatrixBillingAccess();

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-2 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "provisioning"
              ? "Choose a hosted runtime plan and launch through secure checkout."
              : "Manage Matrix OS hosted runtime billing and payment details."}
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
        entitlement={entitlement}
        accessReason={accessReason}
        mode={mode}
        onCheckoutIntent={onCheckoutIntent}
        checkoutReturnPath={checkoutReturnPath}
      />
    </div>
  );
}
