"use client";

import { Badge } from "@/components/ui/badge";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import type { BillingAccessIssue } from "@/hooks/useMatrixBillingAccess";
import {
  BillingPanel,
  type BillingPanelMode,
  type ComputerSetupSelection,
} from "./BillingPanel";

function BillingStatusBadge({
  active,
  startsNewSubscription,
  accessIssue,
}: {
  active: boolean | null;
  startsNewSubscription: boolean;
  accessIssue: BillingAccessIssue;
}) {
  if (active === false && !startsNewSubscription) return null;

  let className = "border-border/30 bg-muted/30 text-muted-foreground";
  let label = "Checking";
  if (startsNewSubscription) {
    className = "border-[#BED77B] bg-[#F4F7ED] text-[#0E3422]";
    label = "New subscription";
  } else if (active === true) {
    className = "border-[#288A5B]/30 bg-[#EEF7F2] text-[#13492F]";
    label = "Active";
  } else if (accessIssue === "auth") {
    className = "border-sky-500/30 bg-sky-500/10 text-sky-700";
    label = "Reconnecting";
  } else if (accessIssue === "status") {
    className = "border-ember/30 bg-ember/10 text-ember";
    label = "Unavailable";
  }

  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}

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
  const { active, entitlement, trialOffer, accessReason, accessIssue, retry } = useMatrixBillingAccess();
  const startsNewSubscription = mode === "add-computer" && entitlement?.source !== "override";

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-2 font-[family-name:var(--font-geist-sans)] sm:p-4">
      <div className="flex items-center justify-between gap-3 border-b border-[#E0E1CA] pb-3">
        <h2 className="font-[family-name:var(--font-bricolage)] text-xl font-semibold tracking-tight text-[#1F2D1D]">
          Billing
        </h2>
        <BillingStatusBadge
          active={active}
          startsNewSubscription={startsNewSubscription}
          accessIssue={accessIssue}
        />
      </div>

      <BillingPanel
        active={active}
        entitlement={entitlement}
        trialOffer={trialOffer}
        accessReason={accessReason}
        accessIssue={accessIssue}
        onRetry={retry}
        mode={mode}
        onCheckoutIntent={onCheckoutIntent}
        onCheckoutNavigate={onCheckoutNavigate}
        checkoutReturnPath={checkoutReturnPath}
        checkoutRuntimeSlot={checkoutRuntimeSlot}
      />
    </div>
  );
}
