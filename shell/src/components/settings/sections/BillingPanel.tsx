"use client";

import {
  getMatrixDeveloperToolPreinstallLimit,
} from "@matrix-os/contracts";
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
  CheckIcon,
  ChevronDownIcon,
  AlertCircleIcon,
  Loader2Icon,
  MapPinIcon,
  RefreshCwIcon,
} from "@/lib/hugeicons";
import { useUser } from "@clerk/nextjs";
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
import { ActiveBillingPanel, BillingPortalButton, TrialPaymentRecoveryPanel } from "./BillingManagementPanel";
import { isSelfHostedDocument } from "@/lib/self-host-mode";
import {
  constrainDeveloperToolsSelection,
  defaultDeveloperTools,
  nextDeveloperToolsSelection,
  type DeveloperToolId,
} from "@/components/onboarding/developer-tools";
import { DeveloperToolsSelector } from "@/components/onboarding/DefaultInstallsStep";
import { BillingCheckoutPanel } from "./BillingCheckoutPanel";
import {
  captureBillingTelemetry,
  type BillingInterval,
  type BillingPanelMode,
  type BillingTelemetryProperties,
  type ComputerSetupSelection,
} from "./billing-checkout";

export type { BillingPanelMode, ComputerSetupSelection } from "./billing-checkout";

function preselectedFeatureSlug(selectedPlan: unknown): string | null {
  if (typeof selectedPlan !== "string") return null;
  return (
    MATRIX_BILLING_SERVER_PROFILES.find(
      (profile) => profile.planSlug === selectedPlan,
    )?.featureSlug ?? null
  );
}

const regionGroupLabels: Record<string, string> = {
  "eu-central": "Germany",
  "us-east": "United States",
  "us-west": "United States",
};
const profileDescriptions: Record<string, string> = {
  server_starter: "For everyday use",
  server_builder: "For technical work and building",
  server_max: "For serious, demanding workloads",
};

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

function reloadBillingPage(): void {
  window.location.reload();
}

function BillingStatusUnavailablePanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex min-h-48 items-center justify-center rounded-xl border border-ember/25 bg-ember/10 p-4"
      role="alert"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center text-sm text-deep">
        <span className="flex size-10 items-center justify-center rounded-lg border border-ember/25 bg-card">
          <AlertCircleIcon className="size-4 text-ember" aria-hidden="true" />
        </span>
        <span className="font-semibold">Billing status is unavailable</span>
        <span className="leading-6 text-forest/70">
          We could not refresh your billing details. Your billing settings were not changed.
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-lg border border-forest/20 bg-card px-3 py-2 font-semibold text-deep transition-colors hover:bg-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest/40"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
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

function groupRegions(
  availableRegions: typeof MATRIX_BILLING_REGIONS,
): { group: string; regions: (typeof MATRIX_BILLING_REGIONS)[number][] }[] {
  const byGroup = new Map<string, (typeof MATRIX_BILLING_REGIONS)[number][]>();
  for (const region of availableRegions) {
    const group = regionGroupLabels[region.networkZone] ?? "Other";
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(region);
    else byGroup.set(group, [region]);
  }
  return Array.from(byGroup, ([group, regions]) => ({ group, regions }));
}

function RegionOptionRows({
  regions,
  selectedFeature,
  defaultFeature,
  onSelect,
}: {
  regions: typeof MATRIX_BILLING_REGIONS;
  selectedFeature: string;
  defaultFeature: string;
  onSelect: (featureSlug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {groupRegions(regions).map(({ group, regions: groupedRegions }) => (
        <div key={group}>
          <p className="px-1.5 pb-0.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#635F5F]/65">
            {group}
          </p>
          {groupedRegions.map((region) => {
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
  regions,
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
  onClearDeveloperTools,
}: {
  profiles: typeof MATRIX_BILLING_SERVER_PROFILES;
  regions: typeof MATRIX_BILLING_REGIONS;
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
  onClearDeveloperTools: () => void;
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
          onClear={onClearDeveloperTools}
          variant="billing"
          singleChoice={getMatrixDeveloperToolPreinstallLimit(selectedProfile.hetznerType) === 1}
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
                  regions={regions}
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
  onRetry,
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
  onRetry?: () => void;
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
    onRetry,
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
  onRetry?: () => void;
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
  onRetry,
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
  onRetry?: () => void;
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
  const selectedPlanProfile =
    allowedProfiles.find(
      (profile) => profile.featureSlug === selectedProfileSlug,
    ) ?? allowedProfiles[0] ?? MATRIX_BILLING_SERVER_PROFILES[0]!;
  const allowedRegions = checkoutBypassed
    ? MATRIX_BILLING_REGIONS.filter((region) =>
        entitlement.allowedSelections.some(
          (selection) => selection.planSlug === selectedPlanProfile.planSlug
            && selection.regionSlug === region.featureSlug,
        ),
      )
    : MATRIX_BILLING_REGIONS;
  const selectedRegion =
    allowedRegions.find((region) => region.featureSlug === selectedRegionSlug) ??
    allowedRegions[0] ??
    MATRIX_BILLING_REGIONS[0]!;
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity keeps the downstream telemetry memo and ref-sync effect from changing on unrelated checkout state renders.
  const selectedProfile = useMemo(
    () => resolveMatrixServerProfile(selectedPlanProfile, selectedRegion),
    [selectedPlanProfile, selectedRegion],
  );
  const developerToolLimit = getMatrixDeveloperToolPreinstallLimit(selectedProfile.hetznerType);
  const effectiveDeveloperTools = constrainDeveloperToolsSelection(developerTools, developerToolLimit);
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by a useEffect dependency array below (the ref-sync effect keyed on telemetryProperties); removing useMemo would re-run that effect on every render.
  const telemetryProperties = useMemo<BillingTelemetryProperties>(
    () => {
      const billingState = active === null ? "checking" : active ? "active" : "inactive";
      if (active === true && entitlement) {
        const recurringPrice = entitlement.recurringPrice;
        const placement = entitlement.runtimePlacement;
        return {
          mode,
          billing_state: billingState,
          plan_slug: entitlement.planSlug,
          billing_interval: recurringPrice?.interval ?? entitlement.billingInterval ?? undefined,
          recurring_unit_amount_minor: recurringPrice?.unitAmountMinor,
          recurring_total_amount_minor: recurringPrice
            ? recurringPrice.unitAmountMinor * recurringPrice.quantity
            : undefined,
          currency: recurringPrice?.currency,
          price_interval_count: recurringPrice?.intervalCount,
          price_quantity: recurringPrice?.quantity,
          region_slug: placement?.regionSlug,
          location_label: placement?.label,
          country: placement?.countryLabel,
          network_zone: placement?.networkZone,
        };
      }
      return {
        mode,
        billing_state: billingState,
        selected_profile_slug: selectedProfile.featureSlug,
        selected_billing_interval: billingInterval,
        selected_monthly_price_usd: selectedProfile.monthlyPriceUsd ?? undefined,
        selected_annual_price_usd: selectedProfile.annualPriceUsd ?? undefined,
        selected_price_usd: profilePrice(selectedProfile, billingInterval) || undefined,
        selected_region_slug: selectedRegion.featureSlug,
        selected_region_zone: selectedRegion.networkZone,
      };
    },
    [active, billingInterval, entitlement, mode, selectedProfile, selectedRegion],
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
    const nextAllowedRegions = checkoutBypassed
      ? MATRIX_BILLING_REGIONS.filter((region) =>
          entitlement.allowedSelections.some(
            (selection) => selection.planSlug === nextPlanProfile.planSlug
              && selection.regionSlug === region.featureSlug,
          ),
        )
      : MATRIX_BILLING_REGIONS;
    const nextRegion = nextAllowedRegions.some(
      (region) => region.featureSlug === selectedRegion.featureSlug,
    ) ? selectedRegion : nextAllowedRegions[0] ?? selectedRegion;
    const nextProfile = resolveMatrixServerProfile(nextPlanProfile, nextRegion);
    setSelectedProfileSlug(nextPlanProfile.featureSlug);
    if (nextRegion.featureSlug !== selectedRegion.featureSlug) {
      setSelectedRegionOverride(nextRegion.featureSlug);
    }
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
      allowedRegions.find((region) => region.featureSlug === featureSlug) ??
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

  if (accessIssue === "status") {
    return <BillingStatusUnavailablePanel onRetry={onRetry ?? reloadBillingPage} />;
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

  if (checkoutBypassed && (allowedProfiles.length === 0 || allowedRegions.length === 0)) {
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
        {mode !== "add-computer" && entitlement?.portalAvailable === true && (
          <section className="rounded-2xl border border-forest/15 bg-card p-4">
            <h4 className="text-sm font-semibold text-deep">Receipts and payment</h4>
            <p className="my-2 text-sm text-forest/65">
              Your invoices and payment settings remain available while runtime access is paused.
            </p>
            <BillingPortalButton entitlement={entitlement} label="View receipts" />
          </section>
        )}
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
            regions={allowedRegions}
            selectedProfile={selectedProfile}
            selectedRegion={selectedRegion}
            developerTools={effectiveDeveloperTools}
            billingInterval={billingInterval}
            openPicker={openPicker}
            onToggleRegion={() =>
              setOpenPicker((current) => (current === "region" ? null : "region"))
            }
            onClose={() => setOpenPicker(null)}
            onSelectProfile={handleProfileSelect}
            onSelectRegion={handleRegionSelect}
            onToggleDeveloperTool={(tool) => setDeveloperTools(
              (current) => nextDeveloperToolsSelection(current, tool, developerToolLimit === 1),
            )}
            onClearDeveloperTools={() => setDeveloperTools([])}
          />
        </div>
      </div>
      <BillingCheckoutPanel
        key={trialDurationDays ?? "no-trial"}
        onCheckoutIntent={onCheckoutIntent}
        onCheckoutNavigate={onCheckoutNavigate}
        checkoutReturnPath={checkoutReturnPath}
        checkoutRuntimeSlot={checkoutRuntimeSlot}
        checkoutBypassed={checkoutBypassed}
        telemetryProperties={telemetryProperties}
        selectedProfile={selectedProfile}
        selectedRegion={selectedRegion}
        billingInterval={billingInterval}
        developerTools={effectiveDeveloperTools}
        trialDurationDays={trialDurationDays}
      />
    </div>
  );
}
