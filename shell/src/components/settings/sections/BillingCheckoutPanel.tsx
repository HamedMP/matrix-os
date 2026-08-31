"use client";

import { useEffect, useRef, useState } from "react";
import {
  CreditCardIcon,
  Loader2Icon,
  ShieldCheckIcon,
} from "@/lib/hugeicons";
import {
  MATRIX_BILLING_REGIONS,
  MATRIX_BILLING_SERVER_PROFILES,
} from "@/lib/billing";
import type { DeveloperToolId } from "@/components/onboarding/developer-tools";
import {
  captureBillingTelemetry,
  type BillingInterval,
  type BillingTelemetryProperties,
  type ComputerSetupSelection,
} from "./billing-checkout";

const BILLING_PREPARATION_TIMEOUT_MS = 370_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const billingDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function checkoutSelectionConflictMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selection = value as Record<string, unknown>;
  const profile = MATRIX_BILLING_SERVER_PROFILES.find(
    (candidate) => candidate.planSlug === selection.planSlug,
  );
  const region = MATRIX_BILLING_REGIONS.find(
    (candidate) => candidate.featureSlug === selection.regionSlug,
  );
  if (!profile || !region || (selection.interval !== "monthly" && selection.interval !== "annual")) {
    return null;
  }
  return `A ${profile.label} ${selection.interval} checkout in ${region.label} is already open. Select those choices to continue it.`;
}

function checkoutPrice(
  profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number],
  interval: BillingInterval,
): string {
  return interval === "annual"
    ? profile.annualPriceUsd ?? profile.monthlyPriceUsd ?? ""
    : profile.monthlyPriceUsd ?? "";
}

export function BillingCheckoutPanel({
  onCheckoutIntent,
  onCheckoutNavigate,
  checkoutReturnPath,
  checkoutRuntimeSlot,
  checkoutBypassed,
  telemetryProperties,
  selectedProfile,
  selectedRegion,
  billingInterval,
  developerTools,
  trialDurationDays,
}: {
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
  checkoutBypassed?: boolean;
  telemetryProperties: BillingTelemetryProperties;
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
  billingInterval: BillingInterval;
  developerTools: DeveloperToolId[];
  trialDurationDays: number | null;
}) {
  const planSlug = selectedProfile.planSlug;
  const regionSlug = selectedRegion.featureSlug;
  const price = checkoutPrice(selectedProfile, billingInterval);
  const [trialEnd] = useState(() => trialDurationDays === null
    ? null
    : billingDateFormatter.format(new Date(Date.now() + trialDurationDays * DAY_MS)));
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const telemetryPropertiesRef = useRef(telemetryProperties);

  useEffect(() => {
    telemetryPropertiesRef.current = telemetryProperties;
  }, [telemetryProperties]);

  useEffect(() => {
    captureBillingTelemetry("checkout_stripe_available", telemetryPropertiesRef.current);
  }, []);

  function reportCheckoutError(
    errorKind: string,
    message = "Checkout is unavailable. Try again in a moment.",
  ) {
    setCheckoutError(message);
    captureBillingTelemetry("checkout_error", {
      ...telemetryPropertiesRef.current,
      error_kind: errorKind,
    });
  }

  async function startCheckout() {
    const selection = {
      planSlug: selectedProfile.planSlug,
      regionSlug: selectedRegion.featureSlug,
      developerTools: [...developerTools],
    };
    const checkoutAllowed = onCheckoutIntent?.(selection) !== false;
    if (!checkoutAllowed) return;
    if (checkoutBypassed) {
      captureBillingTelemetry("checkout_bypassed", telemetryPropertiesRef.current);
      return;
    }
    setCheckoutLoading(true);
    setCheckoutError(null);
    captureBillingTelemetry("checkout_intent", telemetryPropertiesRef.current);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BILLING_PREPARATION_TIMEOUT_MS);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear the abort timeout and reset `checkoutLoading` on every path; the code is correct and the finalizer must run whether the request resolves, rejects, or throws.
    try {
      const response = await fetch("/billing/checkout", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          planSlug,
          interval: billingInterval,
          regionSlug,
          developerTools,
          ...(checkoutRuntimeSlot ? { runtimeSlot: checkoutRuntimeSlot } : {}),
          ...(checkoutReturnPath ? { returnPath: checkoutReturnPath } : {}),
        }),
      });
      const body = response.ok || response.status === 409
        ? (await response.json().catch((err: unknown) => {
          captureBillingTelemetry("checkout_response_parse_error", {
            ...telemetryPropertiesRef.current,
            error_kind: err instanceof Error ? err.name : typeof err,
          });
          return null;
        })) as { code?: unknown; selection?: unknown; url?: unknown } | null
        : null;
      if (!response.ok) {
        if (response.status === 409 && body?.code === "checkout_selection_conflict") {
          const message = checkoutSelectionConflictMessage(body.selection);
          reportCheckoutError(
            "checkout_selection_conflict",
            message ?? "A checkout with different choices is already open for this computer.",
          );
          return;
        }
        if (response.status === 409 && body?.code === "checkout_pending") {
          reportCheckoutError(
            "checkout_pending",
            "Checkout is still being confirmed. Try again in a moment.",
          );
          return;
        }
        if (response.status === 409 && body?.code === "runtime_already_subscribed") {
          reportCheckoutError(
            "runtime_already_subscribed",
            "Billing is already active for this computer. Refresh to continue.",
          );
          return;
        }
        reportCheckoutError(`http_${response.status}`);
        return;
      }
      if (typeof body?.url !== "string" || body.url.length === 0) {
        reportCheckoutError("invalid_response");
        return;
      }
      (onCheckoutNavigate ?? ((target: string) => window.location.assign(target)))(body.url);
    } catch (error: unknown) {
      reportCheckoutError(error instanceof Error ? error.name : typeof error);
    } finally {
      window.clearTimeout(timeoutId);
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- false positive: this reset is inside the finally block and runs on every completion path.
      setCheckoutLoading(false);
    }
  }

  return (
    <aside className="rounded-2xl bg-[#0E3422] p-5 text-[#FCFCF8] shadow-[0_12px_36px_rgba(31,45,29,0.12)] lg:sticky lg:top-2">
      <div className="flex items-end justify-between gap-4">
        <span className="font-[family-name:var(--font-bricolage)] text-2xl font-semibold tracking-tight">
          {selectedProfile.label}
        </span>
        {!checkoutBypassed && trialDurationDays === null ? (
          <span className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tracking-tight">${price}</span>
            <span className="text-xs text-[#C9E8D9]/65">/month</span>
          </span>
        ) : null}
      </div>
      {trialDurationDays !== null && trialEnd && (
        <div className="mt-5 border-t border-[#C9E8D9]/15 pt-5">
          <p className="text-3xl font-semibold tracking-tight text-cream">$0 today</p>
          <p className="mt-1 text-sm text-[#FCFCF8]">Then ${price}/month on {trialEnd}</p>
        </div>
      )}

      <button
        type="button"
        onClick={startCheckout}
        disabled={checkoutLoading}
        className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#BED77B] px-4 text-sm font-semibold text-[#0E3422] transition-colors hover:bg-[#CEE0AE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F1C379] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0E3422] disabled:cursor-wait disabled:opacity-70"
      >
        {checkoutLoading ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : checkoutBypassed ? null : (
          <CreditCardIcon className="size-4" aria-hidden="true" />
        )}
        {checkoutLoading
          ? "Opening secure checkout"
          : checkoutBypassed
          ? "Continue setup"
          : trialDurationDays !== null
          ? `Start ${trialDurationDays}-day trial`
          : "Continue to pay"}
      </button>

      {!checkoutBypassed && <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] font-medium text-[#C9E8D9]/65">
        <span className="inline-flex items-center gap-1">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          Secure Stripe checkout
        </span>
      </div>}
      {checkoutError && (
        <p className="mt-2 text-center text-xs text-red-300">{checkoutError}</p>
      )}
    </aside>
  );
}
