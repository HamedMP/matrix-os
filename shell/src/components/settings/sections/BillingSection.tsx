"use client";

import { Badge } from "@/components/ui/badge";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import {
  BillingPanel,
  type BillingPanelMode,
  type ComputerSetupSelection,
} from "./BillingPanel";

export function BillingSection({
  mode = "settings",
  onCheckoutIntent,
  onCheckoutNavigate,
  checkoutReturnPath,
  checkoutRuntimeSlot,
}: {
  mode?: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
}) {
  const { active, entitlement, accessReason, accessIssue } = useMatrixBillingAccess();
  const startsNewSubscription = mode === "add-computer" && entitlement?.source !== "override";

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-2 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "device-setup"
              ? "Choose billing in Settings, then Matrix returns to CLI device approval."
              : mode === "add-computer"
              ? "Choose the strength and region for another Matrix computer."
              : mode === "provisioning"
              ? "Choose a hosted runtime plan and launch through secure checkout."
              : "Manage Matrix OS hosted runtime billing and payment details."}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            startsNewSubscription
              ? "border-ember/30 bg-ember/10 text-ember"
              : active === true
              ? "border-forest/25 bg-forest/8 text-forest"
              : accessIssue === "auth"
                ? "border-sky-500/30 bg-sky-500/10 text-sky-700"
              : active === false
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
                : "border-border/30 bg-muted/30 text-muted-foreground"
          }
        >
          {startsNewSubscription
            ? "New subscription"
            : active === true
              ? "Active"
              : accessIssue === "auth"
                ? "Reconnecting"
                : active === false
                  ? "Not active"
                  : "Checking"}
        </Badge>
      </div>

      <BillingPanel
        active={active}
        entitlement={entitlement}
        accessReason={accessReason}
        accessIssue={accessIssue}
        mode={mode}
        onCheckoutIntent={onCheckoutIntent}
        onCheckoutNavigate={onCheckoutNavigate}
        checkoutReturnPath={checkoutReturnPath}
        checkoutRuntimeSlot={checkoutRuntimeSlot}
      />
    </div>
  );
}
