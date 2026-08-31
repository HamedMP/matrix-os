"use client";

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MapPinIcon,
  PlusIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "@/lib/hugeicons";
import { useUser } from "@clerk/nextjs";
import type {
  MatrixHostedBillingPlanSlug,
  MatrixHostedBillingRegionSlug,
} from "@matrix-os/contracts";
import {
  getClosestMatrixRegionSlug,
  MATRIX_BILLING_REGIONS,
  MATRIX_BILLING_SERVER_PROFILES,
  resolveMatrixServerProfile,
} from "@/lib/billing";
import type {
  BillingAccessIssue,
  BillingEntitlementSummary,
  BillingTrialOffer,
} from "@/hooks/useMatrixBillingAccess";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { isSelfHostedDocument } from "@/lib/self-host-mode";
import {
  defaultDeveloperTools,
  nextDeveloperToolsSelection,
  type DeveloperToolId,
} from "@/components/onboarding/developer-tools";
import { DeveloperToolsSelector } from "@/components/onboarding/DefaultInstallsStep";

function preselectedFeatureSlug(selectedPlan: unknown): string | null {
  if (typeof selectedPlan !== "string") return null;
  return (
    MATRIX_BILLING_SERVER_PROFILES.find(
      (profile) => profile.planSlug === selectedPlan,
    )?.featureSlug ?? null
  );
}

export type BillingPanelMode = "settings" | "provisioning" | "device-setup" | "add-computer";
export type ComputerSetupSelection = {
  planSlug: MatrixHostedBillingPlanSlug;
  regionSlug: MatrixHostedBillingRegionSlug;
  developerTools: DeveloperToolId[];
};
type BillingInterval = "monthly" | "annual";

const regionGroupLabels: Record<string, string> = {
  "eu-central": "Germany",
  "us-east": "United States",
  "us-west": "United States",
};
const BILLING_CHECKOUT_TIMEOUT_MS = 10_000;
const BILLING_PREPARATION_TIMEOUT_MS = 370_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const billingPlanNames: Record<string, string> = {
  matrix_starter: "Starter",
  matrix_builder: "Builder",
  matrix_max: "Max",
  internal: "Internal",
};
const profileDescriptions: Record<string, string> = {
  server_starter: "For everyday use",
  server_builder: "For technical work and building",
  server_max: "For serious, demanding workloads",
};
const billingDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

type BillingTelemetryProperties = {
  mode: BillingPanelMode;
  billing_state: "active" | "inactive" | "checking";
  selected_profile_slug: string;
  selected_billing_interval: BillingInterval;
  selected_monthly_price_usd?: string;
  selected_annual_price_usd?: string;
  selected_price_usd?: string;
  selected_region_slug: string;
  selected_region_zone: string;
};

function captureBillingTelemetry(
  event: string,
  properties: BillingTelemetryProperties & Record<string, unknown>,
) {
  const payload = {
    source: "settings-billing",
    event,
    ...properties,
  };

  capturePostHogEvent("shell_billing", payload);
  capturePostHogLog(
    event.includes("error") || event.includes("failed") ? "error" : "info",
    `billing ${event}`,
    payload,
  );
}

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

function CheckoutPanel({
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
  const price = profilePrice(selectedProfile, billingInterval);
  const trialEnd = trialDurationDays === null
    ? null
    : billingDateFormatter.format(new Date(Date.now() + trialDurationDays * DAY_MS));
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

function BillingPortalButton({
  entitlement,
  label = "Open billing portal",
}: {
  entitlement: BillingEntitlementSummary | null;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portalAvailable = entitlement?.portalAvailable === true;

  async function openPortal() {
    if (!portalAvailable) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BILLING_CHECKOUT_TIMEOUT_MS);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear the abort timeout and reset `loading` on every path; the code is correct and the finalizer must run whether the request resolves, rejects, or throws.
    try {
      const response = await fetch("/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const body = response.ok
        ? (await response.json().catch((err: unknown) => {
          capturePostHogLog("warn", "billing portal_response_parse_error", {
            source: "settings-billing",
            error_kind: err instanceof Error ? err.name : typeof err,
          });
          return null;
        })) as { url?: string } | null
        : null;
      if (!response.ok || !body?.url) {
        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the throw inside try/catch; intentional control flow routing an unusable portal response into the catch handler. The code is correct.
        throw new Error("portal_unavailable");
      }
      window.location.assign(body.url);
    } catch (err: unknown) {
      setError("Billing portal is unavailable. Try again in a moment.");
      capturePostHogLog("error", "billing portal_error", {
        source: "settings-billing",
        error_kind: err instanceof Error ? err.message : typeof err,
      });
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={openPortal}
        disabled={!portalAvailable || loading}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-forest px-3.5 text-sm font-semibold text-ember-foreground transition-colors hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-55"
      >
        {loading ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ExternalLinkIcon className="size-4" aria-hidden="true" />
        )}
        {loading ? "Opening portal" : label}
      </button>
      {!portalAvailable && (
        <p className="mt-2 text-xs leading-5 text-forest/55">
          This account is managed internally, so receipts and plan changes are handled by the Matrix team.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function ActiveBillingPanel({
  entitlement,
  accessReason,
}: {
  entitlement: BillingEntitlementSummary | null;
  accessReason: string | null;
}) {
  const planName = entitlement ? billingPlanNames[entitlement.planSlug] ?? entitlement.planSlug : "Active";
  const status = entitlement?.status ? formatStatus(entitlement.status) : accessReason === "legacy_clerk_plan" ? "Legacy plan" : "Active";
  const allowedProfiles = MATRIX_BILLING_SERVER_PROFILES.filter((profile) =>
    entitlement?.allowedPlanSlugs.includes(profile.planSlug) === true,
  );
  const totalComputers = entitlement?.maxRuntimeSlots ?? 1;
  const includedComputers = entitlement?.includedRuntimeSlots ?? 1;
  const addonComputers = entitlement?.addonRuntimeSlots ?? 0;
  const graceLabel = entitlement?.gracePeriodEndsAt ? formatDate(entitlement.gracePeriodEndsAt) : null;
  const isTrialing = entitlement?.status === "trialing" && Boolean(entitlement.trialEndsAt);
  const trialEndLabel = entitlement?.trialEndsAt ? formatDate(entitlement.trialEndsAt) : null;
  const billingInterval = entitlement?.billingInterval === "annual" ? "annual" : "monthly";

  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
              {isTrialing ? "Free trial active" : "Current plan"}
            </p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">
              {planName}
            </h3>
            <p className="mt-1 text-sm leading-6 text-forest/65">
              {isTrialing && trialEndLabel
                ? `Your first ${billingInterval} charge is on ${trialEndLabel}.`
                : `${status}. Your Matrix computers stay available while billing is active${graceLabel ? ` and through the grace period ending ${graceLabel}` : ""}.`}
            </p>
            {isTrialing && trialEndLabel && (
              <p className="mt-1 text-sm font-medium text-ember">
                Cancel before {trialEndLabel} to avoid being charged.
              </p>
            )}
          </div>
          <BillingPortalButton entitlement={entitlement} label={isTrialing ? "Manage trial" : undefined} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <BillingMetric label="Status" value={status} />
          <BillingMetric label="Computers" value={`${totalComputers}`} detail={`${includedComputers} included${addonComputers ? `, ${addonComputers} add-on` : ""}`} />
          <BillingMetric
            label="Billing"
            value={billingInterval === "annual" ? "Annual" : "Monthly"}
            detail="Managed subscription"
          />
          <BillingMetric label="Add-ons" value={addonComputers ? `${addonComputers} active` : "None"} detail="Extra machines and storage appear here" />
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <BillingAction
          icon={<ArrowUpRightIcon className="size-4" aria-hidden="true" />}
          title="Upgrade or downgrade"
          description={`Switch between ${allowedProfiles.length ? allowedProfiles.map((profile) => profile.label).join(", ") : "Starter, Builder, and Max"} without deleting data or machines.`}
          action={<BillingPortalButton entitlement={entitlement} label="Change plan" />}
        />
        <BillingAction
          icon={<PlusIcon className="size-4" aria-hidden="true" />}
          title="Add-ons"
          description="Add extra machines first; storage and other hosted capacity can be attached as add-ons as they launch."
          action={<BillingPortalButton entitlement={entitlement} label="Manage add-ons" />}
        />
        <BillingAction
          icon={<ReceiptTextIcon className="size-4" aria-hidden="true" />}
          title="Receipts and payment"
          description="View invoices, receipts, tax details, payment methods, coupons, and billing email in the portal."
          action={<BillingPortalButton entitlement={entitlement} label="View receipts" />}
        />
      </section>

      <section className="rounded-[22px] border border-forest/12 bg-white p-4">
        <div className="flex gap-3">
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-deep">Canceling</h4>
            <p className="mt-1 text-sm leading-6 text-forest/65">
              Canceling is handled in the billing portal. Your machines and owner data are not deleted automatically; access remains while billing is active and through the configured three-day grace window.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function TrialPaymentRecoveryPanel({
  entitlement,
}: {
  entitlement: BillingEntitlementSummary;
}) {
  return (
    <section className="rounded-[22px] border border-ember/30 bg-card p-4 sm:p-5" role="alert">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ember">Trial ended</p>
          <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">Payment required</h3>
          <p className="mt-1 text-sm leading-6 text-forest/65">
            Runtime access is paused until the first payment succeeds.
          </p>
          <p className="mt-1 text-xs leading-5 text-forest/55">
            Update your card in Stripe. Matrix restores access automatically after the paid invoice webhook arrives.
          </p>
        </div>
        <BillingPortalButton entitlement={entitlement} label="Update payment method" />
      </div>
    </section>
  );
}

function BillingSessionRefreshingPanel() {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div
        aria-busy="true"
        aria-live="polite"
        className="flex max-w-md flex-col items-center gap-3 text-center text-sm text-sky-900"
      >
        <span className="flex size-10 items-center justify-center rounded-lg border border-sky-500/20 bg-white">
          <Loader2Icon className="size-4 animate-spin text-sky-700" aria-hidden="true" />
        </span>
        <span className="font-semibold">Reconnecting billing session</span>
        <span className="leading-6 text-sky-900/70">
          Matrix is refreshing your desktop session before checking billing.
        </span>
      </div>
    </div>
  );
}

function BillingMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-forest/10 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-forest/45">{label}</p>
      <p className="mt-2 text-lg font-semibold text-deep">{value}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-forest/55">{detail}</p>}
    </div>
  );
}

function BillingAction({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="rounded-[22px] border border-forest/12 bg-white p-4">
      <div className="flex items-center gap-2 text-deep">
        <span className="inline-flex size-8 items-center justify-center rounded-xl bg-[#f4efe3] text-ember">
          {icon}
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <p className="mt-3 min-h-16 text-sm leading-6 text-forest/65">{description}</p>
      <div className="mt-3">{action}</div>
    </div>
  );
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return billingDateFormatter.format(date);
}

function profilePrice(
  profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number],
  interval: BillingInterval,
): string {
  return interval === "annual"
    ? profile.annualPriceUsd ?? profile.monthlyPriceUsd ?? ""
    : profile.monthlyPriceUsd ?? "";
}

function getDefaultRegionSlug(): string {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error: unknown) {
    console.warn("[billing] unable to resolve browser timezone", error instanceof Error ? error.name : typeof error);
  }
  return getClosestMatrixRegionSlug(timeZone);
}

function subscribeToBrowserTimeZone(): () => void {
  return () => undefined;
}

function getServerRegionSlug(): string {
  return "region_fsn1";
}

function subscribeToSelfHostedDocument(): () => void {
  return () => undefined;
}

function getServerSelfHostedDocument(): boolean {
  return false;
}

function ProfileOptionRows({
  profiles,
  region,
  selectedFeature,
  billingInterval,
  showPrice,
  onSelect,
}: {
  profiles: typeof MATRIX_BILLING_SERVER_PROFILES;
  region: (typeof MATRIX_BILLING_REGIONS)[number];
  selectedFeature: string;
  billingInterval: BillingInterval;
  showPrice: boolean;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {profiles.map((profile) => {
        const resolvedProfile = resolveMatrixServerProfile(profile, region);
        const selected = profile.featureSlug === selectedFeature;
        return (
          <button
            type="button"
            key={profile.featureSlug}
            aria-pressed={selected}
            onClick={() => onSelect(profile.featureSlug)}
            className={`flex min-w-0 flex-col rounded-xl border p-3 text-left transition-all duration-200 ${
              selected
                ? "border-[#0E3422] bg-[#F4F7ED] shadow-[0_2px_8px_rgba(31,45,29,0.07)]"
                : "border-[#E0E1CA] bg-[#FCFCF8] hover:border-[#97D8B9]"
            }`}
          >
            <span className="flex w-full items-start justify-between gap-2">
              <span className="font-[family-name:var(--font-bricolage)] text-sm font-semibold text-[#1F2D1D]">
                {profile.label}
              </span>
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                  selected
                    ? "border-[#0E3422] bg-[#BED77B] text-[#0E3422]"
                    : "border-[#C8C6C6] text-transparent"
                }`}
              >
                <CheckIcon className="size-3" aria-hidden="true" />
              </span>
            </span>
            {showPrice ? (
              <span className="mt-2 flex items-baseline gap-1">
                <>
                  <span className="text-xl font-semibold tracking-tight text-[#1F2D1D]">
                    ${profilePrice(resolvedProfile, billingInterval)}
                  </span>
                  <span className="text-[10px] text-[#635F5F]">/mo</span>
                </>
              </span>
            ) : null}
            <span className="mt-2 text-xs leading-4 text-[#635F5F]">
              {profileDescriptions[profile.featureSlug]}
            </span>
            <span className="mt-1 font-mono text-[10px] leading-4 text-[#635F5F]">
              {resolvedProfile.vcpus} CPU · {resolvedProfile.memoryGb} GB RAM · {resolvedProfile.diskGb} GB disk
            </span>
            {profile.planSlug === "matrix_builder" && (
              <span className="mt-2 w-fit rounded-full bg-[#E4EDD4] px-2 py-0.5 text-[10px] font-semibold text-[#0E3422]">
                Recommended
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function groupRegions(): { group: string; regions: (typeof MATRIX_BILLING_REGIONS)[number][] }[] {
  const byGroup = new Map<string, (typeof MATRIX_BILLING_REGIONS)[number][]>();
  for (const region of MATRIX_BILLING_REGIONS) {
    const group = regionGroupLabels[region.networkZone] ?? "Other";
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(region);
    else byGroup.set(group, [region]);
  }
  return Array.from(byGroup, ([group, regions]) => ({ group, regions }));
}

function RegionOptionRows({
  selectedFeature,
  defaultFeature,
  onSelect,
}: {
  selectedFeature: string;
  defaultFeature: string;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {groupRegions().map(({ group, regions }) => (
        <div key={group}>
          <p className="px-1.5 pb-0.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#635F5F]/65">
            {group}
          </p>
          {regions.map((region) => {
            const selected = region.featureSlug === selectedFeature;
            return (
              <button
                type="button"
                key={region.featureSlug}
                aria-pressed={selected}
                onClick={() => onSelect(region.featureSlug)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? "border-[#0E3422] bg-[#F4F7ED]"
                    : "border-transparent hover:bg-[#EEF7F2]"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="text-base leading-none" aria-hidden="true">
                    {region.flag}
                  </span>
                  <span className="truncate text-sm font-medium text-[#1F2D1D]">{region.label}</span>
                  <span className="font-mono text-[11px] text-[#827D7D]">{region.location}</span>
                  {region.featureSlug === defaultFeature && (
                    <span className="shrink-0 rounded-full bg-[#E4EDD4] px-1.5 py-0.5 text-[10px] font-semibold text-[#475926]">
                      Closest
                    </span>
                  )}
                </span>
                {selected ? (
                  <CheckIcon className="size-4 shrink-0 text-[#0E3422]" aria-hidden="true" />
                ) : (
                  <MapPinIcon className="size-4 shrink-0 text-[#A8A4A4]" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type PickerKey = "region" | null;

function pickerFieldState(open: boolean): string {
  return open
    ? "border-[#0E3422] bg-white shadow-[0_4px_24px_rgba(31,45,29,0.08)]"
    : "border-[#E0E1CA] bg-[#FCFCF8] hover:border-[#97D8B9]";
}

function PickerDropdown({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-2 w-full max-w-[calc(100vw-2.5rem)] origin-top overflow-hidden rounded-xl border border-[#E0E1CA] bg-white p-2 shadow-[0_12px_36px_rgba(31,45,29,0.12)]">
      <div className="flex items-baseline justify-between gap-3 border-b border-[#E0E1CA] px-1.5 pb-2">
        <p className="text-xs font-semibold text-[#1F2D1D]">{title}</p>
        {hint ? <p className="truncate text-[11px] text-[#635F5F]">{hint}</p> : null}
      </div>
      <div className="max-h-[clamp(160px,42vh,340px)] overflow-y-auto overflow-x-hidden pt-1.5">
        {children}
      </div>
    </div>
  );
}

function SelectionTriggerCards({
  profiles,
  selectedProfile,
  selectedRegion,
  developerTools,
  billingInterval,
  showPrice = true,
  openPicker,
  onToggleRegion,
  onClose,
  onSelectProfile,
  onSelectRegion,
  onToggleDeveloperTool,
}: {
  profiles: typeof MATRIX_BILLING_SERVER_PROFILES;
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
  developerTools: DeveloperToolId[];
  billingInterval: BillingInterval;
  showPrice?: boolean;
  openPicker: PickerKey;
  onToggleRegion: () => void;
  onClose: () => void;
  onSelectProfile: (featureSlug: string) => void;
  onSelectRegion: (featureSlug: string) => void;
  onToggleDeveloperTool: (tool: DeveloperToolId) => void;
}) {
  const regionOpen = openPicker === "region";
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseEvent = useEffectEvent(onClose);
  const defaultRegionSlug = getDefaultRegionSlug();

  useEffect(() => {
    if (!openPicker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onCloseEvent();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Stop the event from bubbling to the Settings panel's window-level
        // Escape handler, which would otherwise dismiss the entire panel and
        // discard the in-progress plan/region selection.
        event.stopPropagation();
        onCloseEvent();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openPicker]);

  function toggleAdvancedSettings() {
    if (advancedOpen && regionOpen) onClose();
    setAdvancedOpen((current) => !current);
  }

  return (
    <div ref={containerRef} className="space-y-4">
      <fieldset aria-label="Choose your Matrix computer">
        <ProfileOptionRows
          profiles={profiles}
          region={selectedRegion}
          selectedFeature={selectedProfile.featureSlug}
          billingInterval={billingInterval}
          showPrice={showPrice}
          onSelect={onSelectProfile}
        />
      </fieldset>

      <div className="border-t border-[#E0E1CA] pt-4">
        <DeveloperToolsSelector
          selectedTools={developerTools}
          onToggle={onToggleDeveloperTool}
          variant="billing"
        />
      </div>

      <div className="border-t border-[#E0E1CA] pt-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={toggleAdvancedSettings}
          className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-left text-sm font-semibold text-[#1F2D1D] transition-colors hover:text-[#0E3422] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F1C379]"
        >
          <span>Advanced settings</span>
          <ChevronDownIcon
            className={`size-4 shrink-0 text-[#635F5F] transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {advancedOpen ? (
          <div className="relative mt-2">
            <button
              type="button"
              aria-label="Change server location"
              aria-haspopup="true"
              aria-expanded={regionOpen}
              onClick={onToggleRegion}
              className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F1C379] ${pickerFieldState(regionOpen)}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#EDF3F7] text-base leading-none">
                  <span aria-hidden="true">{selectedRegion.flag}</span>
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold text-[#1F2D1D]">
                    <span>Region</span> · {selectedRegion.label}
                  </span>
                  <span className="text-[11px] text-[#635F5F]">Closest available</span>
                </span>
              </span>
              <ChevronDownIcon
                className={`size-4 shrink-0 text-[#635F5F] transition-transform ${regionOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {regionOpen ? (
              <PickerDropdown title="Choose a server location" hint="Closest available location is selected">
                <RegionOptionRows
                  selectedFeature={selectedRegion.featureSlug}
                  defaultFeature={defaultRegionSlug}
                  onSelect={onSelectRegion}
                />
              </PickerDropdown>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function BillingPanel({
  active,
  entitlement,
  trialOffer,
  accessReason,
  accessIssue,
  mode = "settings",
  onCheckoutIntent,
  onCheckoutNavigate,
  checkoutReturnPath,
  checkoutRuntimeSlot,
}: {
  active: boolean | null;
  entitlement?: BillingEntitlementSummary | null;
  trialOffer?: BillingTrialOffer | null;
  accessReason?: string | null;
  accessIssue?: BillingAccessIssue;
  mode?: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
}) {
  const selfHostedDocument = useSyncExternalStore(
    subscribeToSelfHostedDocument,
    isSelfHostedDocument,
    getServerSelfHostedDocument,
  );
  const props = {
    active,
    entitlement,
    trialOffer,
    accessReason,
    accessIssue,
    mode,
    onCheckoutIntent,
    onCheckoutNavigate,
    checkoutReturnPath,
    checkoutRuntimeSlot,
  };
  if (selfHostedDocument) {
    return <BillingPanelInner {...props} selectedPlan={undefined} />;
  }
  return <ManagedBillingPanel {...props} />;
}

function ManagedBillingPanel(props: {
  active: boolean | null;
  entitlement?: BillingEntitlementSummary | null;
  trialOffer?: BillingTrialOffer | null;
  accessReason?: string | null;
  accessIssue?: BillingAccessIssue;
  mode: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
}) {
  const { user } = useUser();
  return <BillingPanelInner {...props} selectedPlan={user?.publicMetadata?.selectedPlan} />;
}

function BillingPanelInner({
  active,
  entitlement,
  trialOffer,
  accessReason,
  accessIssue,
  mode = "settings",
  onCheckoutIntent,
  onCheckoutNavigate,
  checkoutReturnPath,
  checkoutRuntimeSlot,
  selectedPlan,
}: {
  active: boolean | null;
  entitlement?: BillingEntitlementSummary | null;
  trialOffer?: BillingTrialOffer | null;
  accessReason?: string | null;
  accessIssue?: BillingAccessIssue;
  mode?: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
  selectedPlan?: unknown;
}) {
  const [selectedProfileSlug, setSelectedProfileSlug] = useState<string>(
    () =>
      preselectedFeatureSlug(selectedPlan) ??
      MATRIX_BILLING_SERVER_PROFILES[1]?.featureSlug ??
      MATRIX_BILLING_SERVER_PROFILES[0]?.featureSlug ??
      "",
  );
  const automaticRegionSlug = useSyncExternalStore(
    subscribeToBrowserTimeZone,
    getDefaultRegionSlug,
    getServerRegionSlug,
  );
  const [selectedRegionOverride, setSelectedRegionOverride] = useState<string | null>(null);
  const selectedRegionSlug = selectedRegionOverride ?? automaticRegionSlug;
  const billingInterval: BillingInterval = "monthly";
  const [developerTools, setDeveloperTools] = useState<DeveloperToolId[]>(defaultDeveloperTools);
  const [openPicker, setOpenPicker] = useState<PickerKey>(null);
  const checkoutBypassed = mode === "add-computer" && entitlement?.source === "override";
  const trialDurationDays = trialOffer?.eligible === true
    && mode !== "add-computer"
    && (checkoutRuntimeSlot === undefined || checkoutRuntimeSlot === "primary")
    && !checkoutBypassed
    ? trialOffer.durationDays
    : null;
  const allowedProfiles = checkoutBypassed
    ? MATRIX_BILLING_SERVER_PROFILES.filter((profile) =>
        entitlement.allowedPlanSlugs.includes(profile.planSlug),
      )
    : MATRIX_BILLING_SERVER_PROFILES;
  const selectedRegion =
    MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === selectedRegionSlug) ??
    MATRIX_BILLING_REGIONS[0]!;
  const selectedPlanProfile =
    allowedProfiles.find(
      (profile) => profile.featureSlug === selectedProfileSlug,
    ) ?? allowedProfiles[0] ?? MATRIX_BILLING_SERVER_PROFILES[0]!;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity keeps the downstream telemetry memo and ref-sync effect from changing on unrelated checkout state renders.
  const selectedProfile = useMemo(
    () => resolveMatrixServerProfile(selectedPlanProfile, selectedRegion),
    [selectedPlanProfile, selectedRegion],
  );
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by a useEffect dependency array below (the ref-sync effect keyed on telemetryProperties); removing useMemo would re-run that effect on every render.
  const telemetryProperties = useMemo<BillingTelemetryProperties>(
    () => ({
      mode,
      billing_state: active === null ? "checking" : active ? "active" : "inactive",
      selected_profile_slug: selectedProfile.featureSlug,
      selected_billing_interval: billingInterval,
      selected_monthly_price_usd: selectedProfile.monthlyPriceUsd ?? undefined,
      selected_annual_price_usd: selectedProfile.annualPriceUsd ?? undefined,
      selected_price_usd: profilePrice(selectedProfile, billingInterval) || undefined,
      selected_region_slug: selectedRegion.featureSlug,
      selected_region_zone: selectedRegion.networkZone,
    }),
    [active, billingInterval, mode, selectedProfile, selectedRegion],
  );
  const initialViewTracked = useRef(false);
  const telemetryPropertiesRef = useRef(telemetryProperties);

  useEffect(() => {
    telemetryPropertiesRef.current = telemetryProperties;
  }, [telemetryProperties]);

  useEffect(() => {
    if (active === null || initialViewTracked.current) return;
    initialViewTracked.current = true;
    captureBillingTelemetry(active ? "view_active_billing" : "view_provisioning_billing", {
      ...telemetryPropertiesRef.current,
      auto_selected_region: getDefaultRegionSlug(),
    });
  }, [active]);

  const handleProfileSelect = (featureSlug: string) => {
    const nextPlanProfile =
      allowedProfiles.find((profile) => profile.featureSlug === featureSlug) ??
      selectedPlanProfile;
    const nextProfile = resolveMatrixServerProfile(nextPlanProfile, selectedRegion);
    setSelectedProfileSlug(featureSlug);
    setOpenPicker(null);
    captureBillingTelemetry("profile_select", {
      ...telemetryProperties,
      selected_profile_slug: nextProfile.featureSlug,
      selected_monthly_price_usd: nextProfile.monthlyPriceUsd ?? undefined,
      selected_annual_price_usd: nextProfile.annualPriceUsd ?? undefined,
      selected_price_usd: profilePrice(nextProfile, billingInterval) || undefined,
    });
  };

  const handleRegionSelect = (featureSlug: string) => {
    const nextRegion =
      MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === featureSlug) ??
      selectedRegion;
    setSelectedRegionOverride(featureSlug);
    setOpenPicker(null);
    captureBillingTelemetry("region_select", {
      ...telemetryProperties,
      selected_region_slug: nextRegion.featureSlug,
      selected_region_zone: nextRegion.networkZone,
    });
  };

  if (active === true && mode !== "add-computer") {
    return <ActiveBillingPanel entitlement={entitlement ?? null} accessReason={accessReason ?? null} />;
  }

  if (accessIssue === "auth") {
    return <BillingSessionRefreshingPanel />;
  }

  if (active === null) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-xl border border-border/60 bg-card p-4">
        <output className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Checking billing status
        </output>
      </div>
    );
  }

  if (
    mode !== "add-computer"
    && entitlement?.source === "stripe"
    && Boolean(entitlement.firstTrialPaymentFailedAt)
    && !entitlement.trialConvertedAt
  ) {
    return <TrialPaymentRecoveryPanel entitlement={entitlement} />;
  }

  if (checkoutBypassed && allowedProfiles.length === 0) {
    return (
      <div className="rounded-xl border border-ember/25 bg-ember/10 p-4 text-sm text-deep" role="alert">
        Computer configuration is unavailable for this account. Refresh billing and try again.
      </div>
    );
  }

  return (
    <div
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start"
      data-testid="billing-configurator-layout"
    >
      <div className="space-y-4" data-testid="billing-configurator-main">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#0E3422]/60">
            {mode === "provisioning"
              ? "Provisioning"
              : mode === "add-computer"
              ? "New computer"
              : "Billing"}
          </p>
          <h3 className="mt-1.5 font-[family-name:var(--font-bricolage)] text-2xl font-semibold tracking-tight text-[#1F2D1D] sm:text-[28px]">
            {mode === "device-setup"
              ? "Finish billing"
              : "Choose your Matrix computer"}
          </h3>
        </div>

        <div className="rounded-2xl border border-[#E0E1CA] bg-[#FCFCF8] p-4 shadow-[0_2px_8px_rgba(31,45,29,0.07)] sm:p-5">
          <SelectionTriggerCards
            profiles={allowedProfiles}
            selectedProfile={selectedProfile}
            selectedRegion={selectedRegion}
            developerTools={developerTools}
            billingInterval={billingInterval}
            openPicker={openPicker}
            onToggleRegion={() =>
              setOpenPicker((current) => (current === "region" ? null : "region"))
            }
            onClose={() => setOpenPicker(null)}
            onSelectProfile={handleProfileSelect}
            onSelectRegion={handleRegionSelect}
            onToggleDeveloperTool={(tool) => setDeveloperTools(
              (current) => nextDeveloperToolsSelection(current, tool),
            )}
          />
        </div>
      </div>
      <CheckoutPanel
        onCheckoutIntent={onCheckoutIntent}
        onCheckoutNavigate={onCheckoutNavigate}
        checkoutReturnPath={checkoutReturnPath}
        checkoutRuntimeSlot={checkoutRuntimeSlot}
        checkoutBypassed={checkoutBypassed}
        telemetryProperties={telemetryProperties}
        selectedProfile={selectedProfile}
        selectedRegion={selectedRegion}
        billingInterval={billingInterval}
        developerTools={developerTools}
        trialDurationDays={trialDurationDays}
      />
    </div>
  );
}
