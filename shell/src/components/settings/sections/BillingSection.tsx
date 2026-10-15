"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { desktopPalette, palette } from "@matrix-os/brand";
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
  let style: CSSProperties | undefined;
  let label = "Checking";
  if (accessIssue === "auth") {
    className = "border-sky-500/30 bg-sky-500/10 text-sky-700";
    label = "Reconnecting";
  } else if (accessIssue === "status") {
    className = "border-ember/30 bg-ember/10 text-ember";
    label = "Unavailable";
  } else if (startsNewSubscription) {
    className = "";
    style = {
      backgroundColor: desktopPalette.canvas,
      borderColor: desktopPalette.green,
      color: desktopPalette.forest,
    };
    label = "New subscription";
  } else if (active === true) {
    className = "";
    style = {
      backgroundColor: desktopPalette.surfaceMuted,
      borderColor: desktopPalette.forestHover,
      color: desktopPalette.forest,
    };
    label = "Active";
  }

  return (
    <Badge variant="outline" className={className} style={style}>
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
  const { active, checking, entitlement, trialOffer, activeCheckout, accessReason, accessIssue, retry } = useMatrixBillingAccess(checkoutRuntimeSlot);
  const [checkoutRecoveryError, setCheckoutRecoveryError] = useState<string | null>(null);
  const startsNewSubscription = mode === "add-computer" && entitlement?.source !== "override";
  const refreshCheckoutState = useCallback((errorMessage?: string) => {
    setCheckoutRecoveryError(errorMessage ?? null);
    retry();
  }, [retry]);

  // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- the authoritative refresh decides whether the checkout still exists; clear a prior uncertain-result message only after that refresh finishes without an active checkout.
  useEffect(() => {
    if (!checking && !activeCheckout) setCheckoutRecoveryError(null);
  }, [activeCheckout, checking]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-2 font-[family-name:var(--font-geist-sans)] sm:p-4">
      <div
        className="flex items-center justify-between gap-3 border-b pb-3"
        style={{ borderColor: palette.cream }}
      >
        <h2
          className="font-[family-name:var(--font-bricolage)] text-xl font-semibold tracking-tight"
          style={{ color: palette.brandInk }}
        >
          Billing
        </h2>
        <BillingStatusBadge
          active={active}
          startsNewSubscription={startsNewSubscription}
          accessIssue={accessIssue}
        />
      </div>

      {checkoutRecoveryError ? (
        <p className="rounded-xl border border-ember/25 bg-ember/10 px-4 py-3 text-sm text-deep" role="alert">
          {checkoutRecoveryError}
        </p>
      ) : null}

      <BillingPanel
        active={active}
        entitlement={entitlement}
        trialOffer={trialOffer}
        activeCheckout={activeCheckout}
        accessReason={accessReason}
        accessIssue={accessIssue}
        onRetry={retry}
        onCheckoutStateRefresh={refreshCheckoutState}
        mode={mode}
        onCheckoutIntent={onCheckoutIntent}
        onCheckoutNavigate={onCheckoutNavigate}
        checkoutReturnPath={checkoutReturnPath}
        checkoutRuntimeSlot={checkoutRuntimeSlot}
      />
    </div>
  );
}
