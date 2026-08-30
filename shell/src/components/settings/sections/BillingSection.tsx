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
  const { active, entitlement, trialOffer, accessReason, accessIssue } = useMatrixBillingAccess();
  const startsNewSubscription = mode === "add-computer" && entitlement?.source !== "override";

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-2 sm:p-4">
      <div className="flex items-center justify-between gap-3 border-b border-[#E0E1CA] pb-3">
        <h2 className="font-[family-name:var(--font-bricolage)] text-xl font-semibold tracking-tight text-[#1F2D1D]">
          Billing
        </h2>
        {active !== false || startsNewSubscription ? (
          <Badge
            variant="outline"
            className={
              startsNewSubscription
                ? "border-[#D06E53]/35 bg-[#FAEEEB] text-[#6B3324]"
                : active === true
                  ? "border-[#288A5B]/30 bg-[#EEF7F2] text-[#13492F]"
                  : accessIssue === "auth"
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-700"
                    : "border-border/30 bg-muted/30 text-muted-foreground"
            }
          >
            {startsNewSubscription
              ? "New subscription"
              : active === true
                ? "Active"
                : accessIssue === "auth"
                  ? "Reconnecting"
                  : "Checking"}
          </Badge>
        ) : null}
      </div>

      <BillingPanel
        active={active}
        entitlement={entitlement}
        trialOffer={trialOffer}
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
