"use client";

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { PricingTable } from "@clerk/nextjs";
import {
  CheckCircle2Icon,
  CheckIcon,
  CreditCardIcon,
  CpuIcon,
  Loader2Icon,
  MapPinIcon,
  MemoryStickIcon,
  ServerIcon,
} from "lucide-react";
import {
  MATRIX_BILLING_REGIONS,
  MATRIX_BILLING_SERVER_PROFILES,
} from "@/lib/billing";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";

const shouldRenderClerkPricing =
  process.env.NODE_ENV !== "development";

export type BillingPanelMode = "settings" | "provisioning";

const profileLabels = ["Starter", "Recommended", "Scale"] as const;

type BillingTelemetryProperties = {
  mode: BillingPanelMode;
  billing_state: "active" | "inactive" | "checking";
  selected_profile_slug: string;
  selected_hetzner_type: string;
  selected_monthly_price_usd?: string;
  selected_region_slug: string;
  selected_region_location: string;
  selected_region_zone: string;
  redirect_url_present: boolean;
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

class BillingTableBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[billing] Clerk pricing table failed to render", {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return <BillingUnavailableCard />;
    }

    return this.props.children;
  }
}

function BillingTableFallback() {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-lg border border-border/50 bg-muted/20">
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function BillingUnavailableCard() {
  const defaultProfile = MATRIX_BILLING_SERVER_PROFILES[0];

  return (
    <div className="overflow-hidden rounded-2xl border border-forest/15 bg-white">
      <div className="flex items-baseline justify-between gap-4 border-b border-forest/10 bg-cream/40 px-6 py-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">
            Hosted runtime
          </p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-deep">
            Hosted Matrix trial
          </h3>
        </div>
        <div className="text-right">
          <span className="text-3xl font-semibold tracking-tight text-deep">3 days</span>
          <p className="text-xs text-forest/60">free, then billed</p>
        </div>
      </div>

      <div className="grid gap-3.5 px-6 py-5 text-sm leading-6 text-forest/80">
        {[
          "Your own private Matrix cloud computer, provisioned on demand.",
          `${defaultProfile.label}: ${defaultProfile.vcpus} vCPU, ${defaultProfile.memoryGb} GB memory, ${defaultProfile.diskGb} GB disk.`,
          `$${defaultProfile.monthlyPriceUsd}/mo after the 3-day trial, with a card on file for the dedicated VPS runtime.`,
        ].map((item) => (
          <div key={item} className="flex gap-2.5">
            <CheckCircle2Icon
              className="mt-0.5 size-4 shrink-0 text-ember"
              aria-hidden="true"
            />
            <span>{item}</span>
          </div>
        ))}
      </div>

      <div className="px-6 pb-6">
        <button
          type="button"
          disabled
          className="inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-forest/90 px-4 text-sm font-semibold text-ember-foreground opacity-90"
        >
          <CreditCardIcon className="size-4" aria-hidden="true" />
          Start trial &amp; provision
        </button>
        <p className="mt-3 text-center text-[11px] leading-5 text-forest/45">
          Billing checkout is unavailable in this local preview. Enable Clerk Billing
          for this instance to load the live checkout.
        </p>
      </div>
    </div>
  );
}

function CompactCheckoutFallback() {
  const profile = MATRIX_BILLING_SERVER_PROFILES[0];

  return (
    <div className="rounded-2xl border border-forest/15 bg-white p-3.5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
        Hosted trial
      </p>
      <div className="mt-2 flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold tracking-tight text-deep">
            3 days free
          </p>
          <p className="mt-0.5 text-xs leading-5 text-forest/55">
            Card required when provisioning starts.
          </p>
        </div>
        <p className="text-right text-lg font-semibold text-deep">
          ${profile?.monthlyPriceUsd ?? "14"}/mo
        </p>
      </div>
      <button
        type="button"
        disabled
        className="mt-3 inline-flex h-10 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-forest/90 px-4 text-sm font-semibold text-ember-foreground opacity-90"
      >
        <CreditCardIcon className="size-4" aria-hidden="true" />
        Start trial &amp; provision
      </button>
      <p className="mt-1.5 text-center text-[11px] leading-5 text-forest/45">
        Clerk Billing checkout is unavailable in this local preview.
      </p>
    </div>
  );
}

function CheckoutPanel({
  redirectUrl,
  mode,
  onCheckoutIntent,
  telemetryProperties,
}: {
  redirectUrl: string | null;
  mode: BillingPanelMode;
  onCheckoutIntent?: () => void;
  telemetryProperties: BillingTelemetryProperties;
}) {
  const checkoutTelemetryKey = `${redirectUrl ? "redirect" : "pending"}:${shouldRenderClerkPricing ? "clerk" : "fallback"}`;
  const telemetryPropertiesRef = useRef(telemetryProperties);

  useEffect(() => {
    telemetryPropertiesRef.current = telemetryProperties;
  }, [telemetryProperties]);

  useEffect(() => {
    captureBillingTelemetry(
      redirectUrl && shouldRenderClerkPricing
        ? "checkout_pricing_table_available"
        : redirectUrl
          ? "checkout_local_preview_unavailable"
          : "checkout_redirect_pending",
      telemetryPropertiesRef.current,
    );
  }, [checkoutTelemetryKey]);

  return (
    <div
      className="rounded-2xl border border-forest/15 bg-card p-4"
      onClickCapture={(event) => handleCheckoutClick(event, onCheckoutIntent)}
      onKeyDownCapture={(event) => handleCheckoutKeyDown(event, onCheckoutIntent)}
    >
      {mode === "provisioning" && (
        <div className="mb-2">
          <p className="text-sm font-semibold text-deep">Start trial &amp; provision</p>
          <p className="mt-0.5 text-xs leading-5 text-forest/60">
            Checkout runs here; Matrix starts provisioning after the trial is active.
          </p>
        </div>
      )}
      {redirectUrl && shouldRenderClerkPricing ? (
        <BillingTableBoundary>
          <PricingTable
            for="user"
            newSubscriptionRedirectUrl={redirectUrl}
            fallback={<BillingTableFallback />}
          />
        </BillingTableBoundary>
      ) : redirectUrl ? (
        <CompactCheckoutFallback />
      ) : (
        <BillingTableFallback />
      )}
    </div>
  );
}

function profileSpec(profile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number]): string {
  return `${profile.vcpus} vCPU / ${profile.memoryGb} GB RAM / ${profile.diskGb} GB disk`;
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

function ServerProfileGrid({
  selectedFeature,
  onSelect,
}: {
  selectedFeature: string;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {MATRIX_BILLING_SERVER_PROFILES.map((profile, index) => {
        const selected = profile.featureSlug === selectedFeature;
        return (
        <button
          type="button"
          key={profile.featureSlug}
          aria-pressed={selected}
          onClick={() => onSelect(profile.featureSlug)}
          className={`group flex min-h-[154px] flex-col rounded-2xl border p-3 text-left transition-all ${
            selected
              ? "border-ember bg-[#fff7ec] shadow-[0_18px_50px_rgba(83,68,48,0.16)]"
              : "border-forest/12 bg-white hover:-translate-y-0.5 hover:border-forest/25 hover:shadow-[0_14px_34px_rgba(83,68,48,0.08)]"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  selected ? "bg-ember text-ember-foreground" : "bg-forest/8 text-forest/70"
                }`}
              >
                {profileLabels[index] ?? "Plan"}
              </span>
              <p className="mt-2 text-lg font-semibold tracking-tight text-deep">
                {profile.label}
              </p>
              <p className="text-xs font-medium text-forest/45">{profile.hetznerType}</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold tracking-tight text-deep">
                ${profile.monthlyPriceUsd}
              </p>
              <p className="text-xs text-forest/50">/mo</p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-[#f4efe3] px-2.5 py-2">
              <CpuIcon className="mb-1 size-3 text-ember" aria-hidden="true" />
              <p className="text-sm font-semibold text-deep">{profile.vcpus}</p>
              <p className="text-[10px] text-forest/55">vCPU</p>
            </div>
            <div className="rounded-xl bg-[#f4efe3] px-2.5 py-2">
              <MemoryStickIcon className="mb-1 size-3 text-ember" aria-hidden="true" />
              <p className="text-sm font-semibold text-deep">{profile.memoryGb}</p>
              <p className="text-[10px] text-forest/55">GB RAM</p>
            </div>
            <div className="rounded-xl bg-[#f4efe3] px-2.5 py-2">
              <ServerIcon className="mb-1 size-3 text-ember" aria-hidden="true" />
              <p className="text-sm font-semibold text-deep">{profile.diskGb}</p>
              <p className="text-[10px] text-forest/55">GB disk</p>
            </div>
          </div>

          <div className="mt-auto flex items-center justify-between pt-2.5">
            <span className="text-xs text-forest/50">
              {profileSpec(profile)}
            </span>
            <span
              className={`flex size-6 items-center justify-center rounded-full border ${
                selected
                  ? "border-ember bg-ember text-ember-foreground"
                  : "border-forest/15 text-transparent group-hover:text-forest/30"
              }`}
            >
              <CheckIcon className="size-3.5" aria-hidden="true" />
            </span>
          </div>
        </button>
        );
      })}
    </div>
  );
}

function RegionList({
  selectedFeature,
  onSelect,
}: {
  selectedFeature: string;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {MATRIX_BILLING_REGIONS.map((region) => (
        <button
          type="button"
          key={region.featureSlug}
          aria-pressed={region.featureSlug === selectedFeature}
          onClick={() => onSelect(region.featureSlug)}
          className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-all ${
            region.featureSlug === selectedFeature
              ? "border-ember bg-[#fff7ec] shadow-[0_10px_24px_rgba(83,68,48,0.10)]"
              : "border-forest/10 bg-white hover:border-forest/25"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="text-lg leading-none" aria-hidden="true">
              {region.flag}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-deep">
                {region.label}
              </span>
              <span className="block text-xs text-forest/50">
                {region.location}
              </span>
            </span>
          </span>
          {region.featureSlug === selectedFeature ? (
            <CheckIcon className="size-4 shrink-0 text-ember" aria-hidden="true" />
          ) : (
            <MapPinIcon className="size-4 shrink-0 text-forest/28" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  );
}

function TrialSummary({
  selectedProfile,
  selectedRegion,
}: {
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
}) {
  return (
    <div className="rounded-2xl border border-forest/15 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
        Trial summary
      </p>
      <div className="mt-4 rounded-2xl bg-[#f4efe3] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold tracking-tight text-deep">
              {selectedProfile.label}
            </p>
            <p className="mt-1 text-sm text-forest/60">
              {profileSpec(selectedProfile)}
            </p>
          </div>
          <p className="text-3xl font-semibold tracking-tight text-deep">
            ${selectedProfile.monthlyPriceUsd}
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-forest/10 pt-3 text-sm">
          <span className="text-forest/55">Region</span>
          <span className="font-medium text-deep">
            <span aria-hidden="true">{selectedRegion.flag}</span> {selectedRegion.label}
          </span>
        </div>
      </div>
      <div className="mt-4 grid gap-2 text-sm text-forest/70">
        {[
          "3 days free with card on file.",
          "Dedicated VPS attached after checkout.",
          "Machine size comes from the billing entitlement.",
        ].map((item) => (
          <div key={item} className="flex gap-2">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-ember" aria-hidden="true" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroSelectionPreview({
  selectedProfile,
  selectedRegion,
}: {
  selectedProfile: (typeof MATRIX_BILLING_SERVER_PROFILES)[number];
  selectedRegion: (typeof MATRIX_BILLING_REGIONS)[number];
}) {
  return (
    <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
      <div className="rounded-2xl border border-forest/10 bg-white/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-forest/45">
              Computer
            </p>
            <p className="mt-1 text-base font-semibold text-deep">
              {selectedProfile.label}
            </p>
            <p className="text-xs text-forest/50">{selectedProfile.hetznerType}</p>
          </div>
          <p className="text-lg font-semibold text-deep">
            ${selectedProfile.monthlyPriceUsd}/mo
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs text-forest/65">
          <span className="rounded-md bg-[#f4efe3] px-2 py-1">{selectedProfile.vcpus} vCPU</span>
          <span className="rounded-md bg-[#f4efe3] px-2 py-1">{selectedProfile.memoryGb} GB RAM</span>
          <span className="rounded-md bg-[#f4efe3] px-2 py-1">{selectedProfile.diskGb} GB disk</span>
        </div>
      </div>

      <div className="rounded-2xl border border-forest/10 bg-white/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-forest/45">
          Region
        </p>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="text-2xl leading-none" aria-hidden="true">
            {selectedRegion.flag}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-deep">
              {selectedRegion.label}
            </p>
            <p className="text-xs text-forest/50">
              {selectedRegion.location} · selected automatically
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function handleCheckoutKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onCheckoutIntent?: () => void,
) {
  if (!onCheckoutIntent) return;
  if ((event.key === "Enter" || event.key === " ") && isCheckoutIntentTarget(event.target)) {
    onCheckoutIntent();
  }
}

function handleCheckoutClick(
  event: MouseEvent<HTMLDivElement>,
  onCheckoutIntent?: () => void,
) {
  if (!onCheckoutIntent || !isCheckoutIntentTarget(event.target)) return;
  onCheckoutIntent();
}

function isCheckoutIntentTarget(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  const action = target.closest("button,a,[role='button']");
  if (!action) return false;
  const role = action.getAttribute("role");
  if (role === "radio" || role === "tab") return false;
  const label = `${action.textContent ?? ""} ${action.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /\b(start|trial|checkout|subscribe|upgrade|continue)\b/.test(label);
}

export function BillingPanel({
  active,
  redirectUrl,
  mode = "settings",
  onCheckoutIntent,
}: {
  active: boolean | null;
  redirectUrl: string | null;
  mode?: BillingPanelMode;
  onCheckoutIntent?: () => void;
}) {
  const [selectedProfileSlug, setSelectedProfileSlug] = useState<string>(
    MATRIX_BILLING_SERVER_PROFILES[1]?.featureSlug ??
      MATRIX_BILLING_SERVER_PROFILES[0]?.featureSlug ??
      "",
  );
  const [selectedRegionSlug, setSelectedRegionSlug] = useState(getNearestRegionSlug);
  const selectedProfile =
    MATRIX_BILLING_SERVER_PROFILES.find(
      (profile) => profile.featureSlug === selectedProfileSlug,
    ) ?? MATRIX_BILLING_SERVER_PROFILES[0]!;
  const selectedRegion =
    MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === selectedRegionSlug) ??
    MATRIX_BILLING_REGIONS[0]!;
  const telemetryProperties = useMemo<BillingTelemetryProperties>(
    () => ({
      mode,
      billing_state: active === null ? "checking" : active ? "active" : "inactive",
      selected_profile_slug: selectedProfile.featureSlug,
      selected_hetzner_type: selectedProfile.hetznerType,
      selected_monthly_price_usd: selectedProfile.monthlyPriceUsd ?? undefined,
      selected_region_slug: selectedRegion.featureSlug,
      selected_region_location: selectedRegion.location,
      selected_region_zone: selectedRegion.networkZone,
      redirect_url_present: redirectUrl !== null,
    }),
    [active, mode, redirectUrl, selectedProfile, selectedRegion],
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
      MATRIX_BILLING_SERVER_PROFILES.find((profile) => profile.featureSlug === featureSlug) ??
      selectedProfile;
    setSelectedProfileSlug(featureSlug);
    captureBillingTelemetry("profile_select", {
      ...telemetryProperties,
      selected_profile_slug: nextProfile.featureSlug,
      selected_hetzner_type: nextProfile.hetznerType,
      selected_monthly_price_usd: nextProfile.monthlyPriceUsd ?? undefined,
    });
  };

  const handleRegionSelect = (featureSlug: string) => {
    const nextRegion =
      MATRIX_BILLING_REGIONS.find((region) => region.featureSlug === featureSlug) ??
      selectedRegion;
    setSelectedRegionSlug(featureSlug);
    captureBillingTelemetry("region_select", {
      ...telemetryProperties,
      selected_region_slug: nextRegion.featureSlug,
      selected_region_location: nextRegion.location,
      selected_region_zone: nextRegion.networkZone,
    });
  };

  const handleCheckoutIntent = () => {
    captureBillingTelemetry("checkout_intent", telemetryProperties);
    onCheckoutIntent?.();
  };

  if (active === true) {
    return (
      <div className="rounded-xl border border-forest/20 bg-forest/5 p-4 text-sm text-forest">
        Billing is active for this Clerk account.
      </div>
    );
  }

  if (active === null) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Checking billing status
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <section className="grid gap-4 rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">
            {mode === "provisioning" ? "Provisioning" : "Billing"}
          </p>
          <h3 className="mt-2 max-w-3xl text-2xl font-semibold tracking-tight text-deep sm:text-3xl">
            {mode === "provisioning"
              ? "Pick the cloud computer Matrix boots on"
              : "Manage your hosted Matrix computer"}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-forest/70">
            Free account first. The hosted trial starts only when checkout confirms
            the card and Matrix can attach a dedicated VPS.
          </p>
          <HeroSelectionPreview
            selectedProfile={selectedProfile}
            selectedRegion={selectedRegion}
          />
        </div>
        <CheckoutPanel
          redirectUrl={redirectUrl}
          mode={mode}
          onCheckoutIntent={handleCheckoutIntent}
          telemetryProperties={telemetryProperties}
        />
      </section>

      <section className="rounded-[22px] border border-forest/12 bg-white p-3.5">
        <div className="mb-3 flex items-center justify-between gap-4 px-1">
          <h4 className="text-sm font-semibold text-deep">Computer</h4>
          <p className="text-xs text-forest/45">Launch tiers: CPX22 / CPX32 / CPX52</p>
        </div>
        <ServerProfileGrid
          selectedFeature={selectedProfile.featureSlug}
          onSelect={handleProfileSelect}
        />
      </section>

      <section className="rounded-[22px] border border-forest/12 bg-white p-3.5">
        <div className="mb-3 flex items-center justify-between gap-4 px-1">
          <h4 className="text-sm font-semibold text-deep">Region</h4>
          <p className="text-xs text-forest/45">
            Closest location is selected automatically
          </p>
        </div>
        <RegionList
          selectedFeature={selectedRegion.featureSlug}
          onSelect={handleRegionSelect}
        />
      </section>

      {process.env.NODE_ENV === "development" && (
        <div className="hidden">
          <TrialSummary selectedProfile={selectedProfile} selectedRegion={selectedRegion} />
        </div>
      )}
    </div>
  );
}
