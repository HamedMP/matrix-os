"use client";

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CpuIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MapPinIcon,
  PlusIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useUser } from "@clerk/nextjs";
import {
  MATRIX_BILLING_REGIONS,
  MATRIX_BILLING_SERVER_PROFILES,
} from "@/lib/billing";
import type {
  BillingAccessIssue,
  BillingEntitlementSummary,
} from "@/hooks/useMatrixBillingAccess";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { isSelfHostedDocument } from "@/lib/self-host-mode";

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
  serverType: string;
  location: string;
};
type BillingInterval = "monthly" | "annual";

const profileLabels = ["Starter", "Recommended", "Scale"] as const;
const profileBlurbs: Record<string, string> = {
  server_cpx22: "Light agents, testing, and small projects",
  server_cpx32: "Everyday building with headroom to grow",
  server_cpx52: "Heavy workloads and many parallel agents",
};
const regionGroupLabels: Record<string, string> = {
  "eu-central": "Europe",
  "us-east": "Americas",
  "us-west": "Americas",
  "ap-southeast": "Asia Pacific",
};
const includedHighlights = [
  "Dedicated VPS attached right after checkout",
  "Your files and data persist across restarts",
  "Change tier or cancel anytime in the billing portal",
] as const;
const BILLING_CHECKOUT_TIMEOUT_MS = 10_000;
const acceptedPaymentMarks = ["Visa", "Mastercard"] as const;
const billingPlanNames: Record<string, string> = {
  matrix_starter: "Starter",
  matrix_builder: "Builder",
  matrix_max: "Max",
  internal: "Internal",
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
  selected_hetzner_type: string;
  selected_billing_interval: BillingInterval;
  selected_monthly_price_usd?: string;
  selected_annual_price_usd?: string;
  selected_price_usd?: string;
  selected_region_slug: string;
  selected_region_location: string;
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

function CheckoutPanel({
  mode,
  onCheckoutIntent,
  onCheckoutNavigate,
  checkoutReturnPath,
  checkoutRuntimeSlot,
  checkoutBypassed,
  telemetryProperties,
  selectedProfile,
  selectedRegion,
  billingInterval,
  onBillingIntervalChange,
}: {
  mode: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
  checkoutBypassed?: boolean;
  telemetryProperties: BillingTelemetryProperties;
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
  billingInterval: BillingInterval;
  onBillingIntervalChange: (interval: BillingInterval) => void;
}) {
  const planSlug = selectedProfile.planSlug;
  const regionSlug = selectedRegion.featureSlug;
  const price = profilePrice(selectedProfile, billingInterval);
  const annualSavings = annualSavingsPercent(selectedProfile);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const telemetryPropertiesRef = useRef(telemetryProperties);

  useEffect(() => {
    telemetryPropertiesRef.current = telemetryProperties;
  }, [telemetryProperties]);

  useEffect(() => {
    captureBillingTelemetry("checkout_stripe_available", telemetryPropertiesRef.current);
  }, []);

  function reportCheckoutError(errorKind: string) {
    setCheckoutError("Checkout is unavailable. Try again in a moment.");
    captureBillingTelemetry("checkout_error", {
      ...telemetryPropertiesRef.current,
      error_kind: errorKind,
    });
  }

  async function startCheckout() {
    const selection = {
      serverType: selectedProfile.hetznerType.toLowerCase(),
      location: selectedRegion.location,
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
    const timeoutId = window.setTimeout(() => controller.abort(), BILLING_CHECKOUT_TIMEOUT_MS);
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
          ...(checkoutRuntimeSlot ? { runtimeSlot: checkoutRuntimeSlot } : {}),
          ...(checkoutReturnPath ? { returnPath: checkoutReturnPath } : {}),
        }),
      });
      if (!response.ok) {
        reportCheckoutError("http_error");
        return;
      }
      const body = (await response.json().catch((err: unknown) => {
        captureBillingTelemetry("checkout_response_parse_error", {
          ...telemetryPropertiesRef.current,
          error_kind: err instanceof Error ? err.name : typeof err,
        });
        return null;
      })) as { url?: string } | null;
      if (!body?.url) {
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
    <aside className="rounded-3xl bg-forest p-4 text-cream/80 sm:p-5 lg:sticky lg:top-2">
      {mode !== "settings" && (
        <div className="mb-4">
          <p className="text-sm font-semibold text-[#FAFAF5]">
            {checkoutBypassed
              ? "Provision this computer"
              : mode === "device-setup"
              ? "Billing settings"
              : "Start checkout & provision"}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-cream/55">
            {checkoutBypassed
              ? "Your internal Matrix account covers this computer."
              : mode === "device-setup"
              ? "Review your plan and region here. Stripe opens only after you choose Continue to pay."
              : "Secure checkout opens before Matrix provisions this computer."}
          </p>
        </div>
      )}

      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cream/45">
        Order summary
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="text-xl font-semibold tracking-tight text-[#FAFAF5]">
          {selectedProfile.label}
        </span>
        <span className="font-mono text-xs text-ember">{selectedProfile.hetznerType}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-cream/55">{profileSpec(selectedProfile)}</p>

      <dl className="mt-4 space-y-2 border-t border-cream/12 pt-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-cream/55">Region</dt>
          <dd className="min-w-0 truncate text-[#FAFAF5]">
            <span aria-hidden="true">{selectedRegion.flag}</span> {selectedRegion.label}
          </dd>
        </div>
        {!checkoutBypassed && <div className="flex items-center justify-between gap-3">
          <dt className="text-cream/55">Billing</dt>
          <dd className="text-[#FAFAF5]">{billingInterval === "annual" ? "Annual" : "Monthly"}</dd>
        </div>}
      </dl>

      {!checkoutBypassed && <div className="mt-4 grid grid-cols-2 rounded-xl bg-black/20 p-1">
        {(["monthly", "annual"] as const).map((interval) => (
          <button
            key={interval}
            type="button"
            aria-pressed={billingInterval === interval}
            onClick={() => onBillingIntervalChange(interval)}
            className={`h-9 rounded-lg text-sm font-semibold transition-colors ${
              billingInterval === interval
                ? "bg-cream text-deep shadow-sm"
                : "text-cream/55 hover:text-cream"
            }`}
          >
            {interval === "monthly" ? "Monthly" : "Annual"}
          </button>
        ))}
      </div>}

      {!checkoutBypassed && <div className="mt-4 flex items-end justify-between gap-3 border-t border-cream/12 pt-4">
        <div>
          <span className="text-sm text-cream/55">Total</span>
          {billingInterval === "annual" && annualSavings ? (
            <span className="mt-0.5 block text-[11px] font-medium text-ember">
              Billed yearly · save {annualSavings}%
            </span>
          ) : null}
        </div>
        <span className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold tracking-tight text-[#FAFAF5]">${price}</span>
          <span className="text-sm text-cream/55">{billingInterval === "annual" ? "/yr" : "/mo"}</span>
        </span>
      </div>}

      <button
        type="button"
        onClick={startCheckout}
        disabled={checkoutLoading}
        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ember px-4 text-sm font-semibold text-ember-foreground transition-colors hover:bg-ember/90 disabled:cursor-wait disabled:opacity-70"
      >
        {checkoutLoading ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : checkoutBypassed ? null : (
          <CreditCardIcon className="size-4" aria-hidden="true" />
        )}
        {checkoutLoading ? "Opening checkout" : checkoutBypassed ? "Continue setup" : "Continue to pay"}
      </button>

      {!checkoutBypassed && <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold text-cream/55">
        <span className="inline-flex items-center gap-1">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          Secure checkout
        </span>
        <span className="text-cream/25" aria-hidden="true">|</span>
        <span className="sr-only">Accepted cards:</span>
        {acceptedPaymentMarks.map((mark) => (
          <span
            key={mark}
            className="inline-flex h-5 items-center rounded border border-cream/20 bg-cream/10 px-2 text-[10px] font-bold uppercase tracking-normal text-cream/85"
          >
            {mark}
          </span>
        ))}
      </div>}
      {!checkoutBypassed && <p className="mt-3 text-center text-[11px] leading-5 text-cream/45">
        No trial. Plan changes and coupons are handled in the billing portal.
      </p>}
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
  const portalAvailable = entitlement?.source === "stripe" && Boolean(entitlement.stripeSubscriptionId);

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
      const body = (await response.json().catch((err: unknown) => {
        capturePostHogLog("warn", "billing portal_response_parse_error", {
          source: "settings-billing",
          error_kind: err instanceof Error ? err.name : typeof err,
        });
        return null;
      })) as { url?: string } | null;
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
  const machineProfile = resolveMachineProfile(entitlement?.defaultServerType);
  const allowedProfiles = (entitlement?.allowedServerTypes ?? [])
    .map(resolveMachineProfile)
    .filter((profile): profile is NonNullable<ReturnType<typeof resolveMachineProfile>> => Boolean(profile));
  const totalComputers = entitlement?.maxRuntimeSlots ?? 1;
  const includedComputers = entitlement?.includedRuntimeSlots ?? 1;
  const addonComputers = entitlement?.addonRuntimeSlots ?? 0;
  const graceLabel = entitlement?.gracePeriodEndsAt ? formatDate(entitlement.gracePeriodEndsAt) : null;

  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
              Current plan
            </p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">
              {planName}
            </h3>
            <p className="mt-1 text-sm leading-6 text-forest/65">
              {status}. Your Matrix computers stay available while billing is active
              {graceLabel ? ` and through the grace period ending ${graceLabel}` : ""}.
            </p>
          </div>
          <BillingPortalButton entitlement={entitlement} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <BillingMetric label="Status" value={status} />
          <BillingMetric label="Computers" value={`${totalComputers}`} detail={`${includedComputers} included${addonComputers ? `, ${addonComputers} add-on` : ""}`} />
          <BillingMetric
            label="Machine"
            value={machineProfile?.label ?? entitlement?.defaultServerType ?? "Included"}
            detail={machineProfile ? `${machineProfile.hetznerType} · ${profileSpec(machineProfile)}` : undefined}
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
          description="Add extra machines first; storage and other Hetzner-backed capacity can be attached as add-ons as they launch."
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

function resolveMachineProfile(serverType: string | null | undefined) {
  if (!serverType) return null;
  return MATRIX_BILLING_SERVER_PROFILES.find(
    (profile) => profile.hetznerType.toLowerCase() === serverType.toLowerCase(),
  ) ?? null;
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

function profileSpec(profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number]): string {
  return `${profile.vcpus} vCPU / ${profile.memoryGb} GB RAM / ${profile.diskGb} GB disk`;
}

function profilePrice(
  profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number],
  interval: BillingInterval,
): string {
  return interval === "annual"
    ? profile.annualPriceUsd ?? profile.monthlyPriceUsd ?? ""
    : profile.monthlyPriceUsd ?? "";
}

function annualSavingsPercent(
  profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number],
): number | null {
  const monthly = Number(profile.monthlyPriceUsd);
  const annual = Number(profile.annualPriceUsd);
  if (!Number.isFinite(monthly) || !Number.isFinite(annual) || monthly <= 0 || annual <= 0) {
    return null;
  }
  const yearlyAtMonthly = monthly * 12;
  if (annual >= yearlyAtMonthly) return null;
  return Math.round((1 - annual / yearlyAtMonthly) * 100);
}

function getNearestRegionSlug(): string {
  if (typeof Intl === "undefined") return MATRIX_BILLING_REGIONS[0]?.featureSlug ?? "";

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone.toLowerCase();
  if (timeZone.startsWith("america/")) {
    return timeZone.includes("los_angeles") ||
      timeZone.includes("vancouver") ||
      timeZone.includes("phoenix") ||
      timeZone.includes("denver") ||
      timeZone.includes("anchorage") ||
      timeZone.includes("honolulu")
      ? "region_hil"
      : "region_ash";
  }
  return "region_fsn1";
}

function ProfileOptionRows({
  profiles,
  selectedFeature,
  billingInterval,
  showPrice,
  onSelect,
}: {
  profiles: typeof MATRIX_BILLING_SERVER_PROFILES;
  selectedFeature: string;
  billingInterval: BillingInterval;
  showPrice: boolean;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {profiles.map((profile) => {
        const selected = profile.featureSlug === selectedFeature;
        return (
          <button
            type="button"
            key={profile.featureSlug}
            aria-pressed={selected}
            onClick={() => onSelect(profile.featureSlug)}
            className={`flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors ${
              selected
                ? "border-ember/55 bg-[#fff7ec]"
                : "border-transparent hover:bg-forest/[0.04]"
            }`}
          >
            <span
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${
                selected
                  ? "border-ember bg-ember text-ember-foreground"
                  : "border-forest/25 text-transparent"
              }`}
            >
              <CheckIcon className="size-3" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-deep">{profile.label}</span>
                <span className="font-mono text-[11px] text-forest/45">{profile.hetznerType}</span>
                {profile.hetznerType.toLowerCase() === "cpx32" && (
                  <span className="rounded-full bg-ember/12 px-1.5 py-0.5 text-[10px] font-semibold text-ember">
                    {profileLabels[1]}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-forest/55">
                {profileBlurbs[profile.featureSlug] ?? ""}
              </span>
              <span className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-forest/55">
                <span>{profile.vcpus} vCPU</span>
                <span className="text-forest/25" aria-hidden="true">·</span>
                <span>{profile.memoryGb} GB RAM</span>
                <span className="text-forest/25" aria-hidden="true">·</span>
                <span>{profile.diskGb} GB SSD</span>
              </span>
            </span>
            {showPrice ? (
              <span className="shrink-0 text-right">
                <span className="text-base font-semibold tracking-tight text-deep">
                  ${profilePrice(profile, billingInterval)}
                </span>
                <span className="block text-[10px] text-forest/45">
                  {billingInterval === "annual" ? "/yr" : "/mo"}
                </span>
              </span>
            ) : null}
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
  nearestFeature,
  onSelect,
}: {
  selectedFeature: string;
  nearestFeature: string;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {groupRegions().map(({ group, regions }) => (
        <div key={group}>
          <p className="px-1.5 pb-0.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-forest/40">
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
                    ? "border-ember/55 bg-[#fff7ec]"
                    : "border-transparent hover:bg-forest/[0.04]"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="text-base leading-none" aria-hidden="true">
                    {region.flag}
                  </span>
                  <span className="truncate text-sm font-medium text-deep">{region.label}</span>
                  <span className="font-mono text-[11px] text-forest/40">{region.location}</span>
                  {region.featureSlug === nearestFeature && (
                    <span className="shrink-0 rounded-full bg-forest/8 px-1.5 py-0.5 text-[10px] font-semibold text-forest/55">
                      Nearest
                    </span>
                  )}
                </span>
                {selected ? (
                  <CheckIcon className="size-4 shrink-0 text-ember" aria-hidden="true" />
                ) : (
                  <MapPinIcon className="size-4 shrink-0 text-forest/25" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type PickerKey = "computer" | "region" | null;

const pickerFieldBase =
  "flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/40";

function pickerFieldState(open: boolean): string {
  return open
    ? "border-ember/60 bg-white shadow-[0_10px_30px_rgba(83,68,48,0.10)]"
    : "border-forest/15 bg-white hover:border-forest/30";
}

function PickerDropdown({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-2 w-full max-w-[calc(100vw-2.5rem)] origin-top overflow-hidden rounded-2xl border border-forest/12 bg-white p-2 shadow-[0_24px_70px_rgba(50,53,46,0.22)]">
      <div className="flex items-baseline justify-between gap-3 border-b border-forest/8 px-1.5 pb-2">
        <p className="text-xs font-semibold text-deep">{title}</p>
        <p className="truncate text-[11px] text-forest/45">{hint}</p>
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
  billingInterval,
  showPrice = true,
  openPicker,
  onToggle,
  onClose,
  onSelectProfile,
  onSelectRegion,
}: {
  profiles: typeof MATRIX_BILLING_SERVER_PROFILES;
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
  billingInterval: BillingInterval;
  showPrice?: boolean;
  openPicker: PickerKey;
  onToggle: (picker: "computer" | "region") => void;
  onClose: () => void;
  onSelectProfile: (featureSlug: string) => void;
  onSelectRegion: (featureSlug: string) => void;
}) {
  const computerOpen = openPicker === "computer";
  const regionOpen = openPicker === "region";
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseEvent = useEffectEvent(onClose);
  const nearestRegionSlug = getNearestRegionSlug();

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

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="relative">
        <button
          type="button"
          aria-label="Change computer"
          aria-haspopup="true"
          aria-expanded={computerOpen}
          onClick={() => onToggle("computer")}
          className={`${pickerFieldBase} ${pickerFieldState(computerOpen)}`}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#f4efe3] text-ember">
              <CpuIcon className="size-5" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-forest/45">
                Computer
              </span>
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-deep">
                  {selectedProfile.label}
                </span>
                <span className="font-mono text-[11px] text-forest/45">
                  {selectedProfile.hetznerType}
                </span>
              </span>
              <span className="truncate font-mono text-[11px] text-forest/45">
                {profileSpec(selectedProfile)}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2.5">
            {showPrice ? (
              <span className="text-right">
                <span className="text-sm font-semibold text-deep">
                  ${profilePrice(selectedProfile, billingInterval)}
                </span>
                <span className="block text-[10px] text-forest/45">
                  {billingInterval === "annual" ? "/yr" : "/mo"}
                </span>
              </span>
            ) : null}
            <ChevronDownIcon
              className={`size-4 text-forest/40 transition-transform ${computerOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </span>
        </button>
        {computerOpen && (
          <PickerDropdown
            title="Choose your computer"
            hint={profiles.map((profile) => profile.hetznerType).join(" / ")}
          >
            <ProfileOptionRows
              profiles={profiles}
              selectedFeature={selectedProfile.featureSlug}
              billingInterval={billingInterval}
              showPrice={showPrice}
              onSelect={onSelectProfile}
            />
          </PickerDropdown>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          aria-label="Change region"
          aria-haspopup="true"
          aria-expanded={regionOpen}
          onClick={() => onToggle("region")}
          className={`${pickerFieldBase} ${pickerFieldState(regionOpen)}`}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#f4efe3] text-xl leading-none">
              <span aria-hidden="true">{selectedRegion.flag}</span>
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-forest/45">
                Region
              </span>
              <span className="truncate text-sm font-semibold text-deep">
                {selectedRegion.label}
              </span>
              <span className="font-mono text-[11px] text-forest/45">
                {selectedRegion.location} · selected automatically
              </span>
            </span>
          </span>
          <ChevronDownIcon
            className={`size-4 shrink-0 text-forest/40 transition-transform ${regionOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {regionOpen && (
          <PickerDropdown title="Choose a region" hint="Closest location is selected automatically">
            <RegionOptionRows
              selectedFeature={selectedRegion.featureSlug}
              nearestFeature={nearestRegionSlug}
              onSelect={onSelectRegion}
            />
          </PickerDropdown>
        )}
      </div>
    </div>
  );
}

export function BillingPanel({
  active,
  entitlement,
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
  accessReason?: string | null;
  accessIssue?: BillingAccessIssue;
  mode?: BillingPanelMode;
  onCheckoutIntent?: (selection: ComputerSetupSelection) => boolean | void;
  onCheckoutNavigate?: (url: string) => void;
  checkoutReturnPath?: string;
  checkoutRuntimeSlot?: string;
}) {
  const props = {
    active,
    entitlement,
    accessReason,
    accessIssue,
    mode,
    onCheckoutIntent,
    onCheckoutNavigate,
    checkoutReturnPath,
    checkoutRuntimeSlot,
  };
  if (isSelfHostedDocument()) {
    return <BillingPanelInner {...props} selectedPlan={undefined} />;
  }
  return <ManagedBillingPanel {...props} />;
}

function ManagedBillingPanel(props: {
  active: boolean | null;
  entitlement?: BillingEntitlementSummary | null;
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
  const [selectedRegionSlug, setSelectedRegionSlug] = useState(getNearestRegionSlug);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("monthly");
  const [openPicker, setOpenPicker] = useState<PickerKey>(null);
  const checkoutBypassed = mode === "add-computer" && entitlement?.source === "override";
  const allowedProfiles = checkoutBypassed
    ? MATRIX_BILLING_SERVER_PROFILES.filter((profile) =>
        entitlement.allowedServerTypes.some(
          (serverType) => serverType.toLowerCase() === profile.hetznerType.toLowerCase(),
        ),
      )
    : MATRIX_BILLING_SERVER_PROFILES;
  const selectedProfile =
    allowedProfiles.find(
      (profile) => profile.featureSlug === selectedProfileSlug,
    ) ?? allowedProfiles[0] ?? MATRIX_BILLING_SERVER_PROFILES[0]!;
  const selectedRegion =
    MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === selectedRegionSlug) ??
    MATRIX_BILLING_REGIONS[0]!;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by a useEffect dependency array below (the ref-sync effect keyed on telemetryProperties); removing useMemo would re-run that effect on every render.
  const telemetryProperties = useMemo<BillingTelemetryProperties>(
    () => ({
      mode,
      billing_state: active === null ? "checking" : active ? "active" : "inactive",
      selected_profile_slug: selectedProfile.featureSlug,
      selected_hetzner_type: selectedProfile.hetznerType,
      selected_billing_interval: billingInterval,
      selected_monthly_price_usd: selectedProfile.monthlyPriceUsd ?? undefined,
      selected_annual_price_usd: selectedProfile.annualPriceUsd ?? undefined,
      selected_price_usd: profilePrice(selectedProfile, billingInterval) || undefined,
      selected_region_slug: selectedRegion.featureSlug,
      selected_region_location: selectedRegion.location,
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
      auto_selected_region: getNearestRegionSlug(),
    });
  }, [active]);

  const handleProfileSelect = (featureSlug: string) => {
    const nextProfile =
      allowedProfiles.find((profile) => profile.featureSlug === featureSlug) ??
      selectedProfile;
    setSelectedProfileSlug(featureSlug);
    setOpenPicker(null);
    captureBillingTelemetry("profile_select", {
      ...telemetryProperties,
      selected_profile_slug: nextProfile.featureSlug,
      selected_hetzner_type: nextProfile.hetznerType,
      selected_monthly_price_usd: nextProfile.monthlyPriceUsd ?? undefined,
      selected_annual_price_usd: nextProfile.annualPriceUsd ?? undefined,
      selected_price_usd: profilePrice(nextProfile, billingInterval) || undefined,
    });
  };

  const handleBillingIntervalChange = (interval: BillingInterval) => {
    setBillingInterval(interval);
    captureBillingTelemetry("billing_interval_select", {
      ...telemetryProperties,
      selected_billing_interval: interval,
      selected_price_usd: profilePrice(selectedProfile, interval) || undefined,
    });
  };

  const handleRegionSelect = (featureSlug: string) => {
    const nextRegion =
      MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === featureSlug) ??
      selectedRegion;
    setSelectedRegionSlug(featureSlug);
    setOpenPicker(null);
    captureBillingTelemetry("region_select", {
      ...telemetryProperties,
      selected_region_slug: nextRegion.featureSlug,
      selected_region_location: nextRegion.location,
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

  if (checkoutBypassed && allowedProfiles.length === 0) {
    return (
      <div className="rounded-xl border border-ember/25 bg-ember/10 p-4 text-sm text-deep" role="alert">
        Computer configuration is unavailable for this account. Refresh billing and try again.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-forest/55">
          {mode === "provisioning"
            ? "Provisioning"
            : mode === "add-computer"
            ? "New computer"
            : "Billing"}
        </p>
        <h3 className="mt-1.5 text-xl font-semibold tracking-tight text-deep sm:text-2xl">
          {mode === "device-setup"
            ? "Finish billing to approve CLI login"
            : mode === "provisioning" || mode === "add-computer"
            ? "Pick the cloud computer Matrix boots on"
            : "Manage your hosted Matrix computer"}
        </h3>
        <p className="mt-1.5 max-w-xl text-sm leading-6 text-forest/65">
          Choose the plan for your hosted runtime. Billing starts in Stripe before Matrix
          attaches a dedicated VPS.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="rounded-3xl border border-forest/12 bg-white p-4 sm:p-5">
          <SelectionTriggerCards
            profiles={allowedProfiles}
            selectedProfile={selectedProfile}
            selectedRegion={selectedRegion}
            billingInterval={billingInterval}
            openPicker={openPicker}
            onToggle={(picker) =>
              setOpenPicker((current) => (current === picker ? null : picker))
            }
            onClose={() => setOpenPicker(null)}
            onSelectProfile={handleProfileSelect}
            onSelectRegion={handleRegionSelect}
          />
          <ul className="mt-4 space-y-2 border-t border-forest/8 pt-4">
            {includedHighlights.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-xs leading-5 text-forest/65"
              >
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-ember" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <CheckoutPanel
          mode={mode}
          onCheckoutIntent={onCheckoutIntent}
          onCheckoutNavigate={onCheckoutNavigate}
          checkoutReturnPath={checkoutReturnPath}
          checkoutRuntimeSlot={checkoutRuntimeSlot}
          checkoutBypassed={checkoutBypassed}
          telemetryProperties={telemetryProperties}
          selectedProfile={selectedProfile}
          selectedRegion={selectedRegion}
          billingInterval={billingInterval}
          onBillingIntervalChange={handleBillingIntervalChange}
        />
      </div>
    </div>
  );
}
