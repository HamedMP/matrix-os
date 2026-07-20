"use client";

import { RedirectToSignIn, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { MatrixComputerListSchema, type MatrixComputerList } from "@matrix-os/contracts";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";
import { ArrowLeftIcon, LogOutIcon, SettingsIcon, UserIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { DefaultInstallsStep } from "@/components/onboarding/DefaultInstallsStep";
import type { DeveloperToolId } from "@/components/onboarding/developer-tools";
import {
  BillingPanel,
  type ComputerSetupSelection,
} from "@/components/settings/sections/BillingPanel";
import type { BillingEntitlementSummary } from "@/hooks/useMatrixBillingAccess";
import { MATRIX_BILLING_REGIONS, MATRIX_BILLING_SERVER_PROFILES } from "@/lib/billing";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import {
  BillingWait,
  ComputerInventory,
  ErrorStep,
  NameStep,
  ProvisioningStep,
  ReadyStep,
  RuntimeLoading,
} from "./RuntimeManagerViews";
import { normalizeRuntimeSlotName, runtimeSlotTitle, validateRuntimeName } from "./runtime-name";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BILLING_POLL_INTERVAL_MS = 3_000;
const DEFAULT_JOURNEY_POLL_INTERVAL_MS = 3_000;
const BILLING_PROJECTION_WAIT_MS = 2 * 60_000;
export const ADD_COMPUTER_DRAFT_KEY = "matrix:add-computer-draft:v1";

type BillingEntitlement = BillingEntitlementSummary;

type BillingStatus = {
  entitlement: BillingEntitlement | null;
  access: { runtimeProxyAllowed: boolean; reason: string };
};

export type JourneyState = {
  phase: "provisioning" | "provisioning_failed" | "ready" | "first_run" | string;
  detail: string;
  progress?: { stage: "creating_server" | "booting" | "registering" | "finalizing"; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
};

type AddComputerDraft = {
  name: string;
  slot: string;
  developerTools: DeveloperToolId[];
  serverType: string;
  location: string;
  baselineMaxRuntimeSlots: number;
  createdAt: number;
};

export type OverviewState =
  | { status: "loading"; inventory: null; billing: null }
  | { status: "ready"; inventory: MatrixComputerList; billing: BillingStatus }
  | { status: "error"; inventory: null; billing: null };

type FlowStep =
  | "list"
  | "name"
  | "configuration"
  | "installs"
  | "billing_wait"
  | "provisioning"
  | "ready"
  | "managed"
  | "error";

type ErrorRetryAction = "billing" | "journey" | "provision";

type RuntimeManagerProps = {
  onExternalNavigate?: (url: string) => void;
  billingPollIntervalMs?: number;
  journeyPollIntervalMs?: number;
};

function hasNewComputerIntent(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("new") === "1";
}

function isDeveloperToolId(value: unknown): value is DeveloperToolId {
  return value === "codex" || value === "claude-code" || value === "opencode" || value === "pi";
}

function isKnownServerType(value: unknown): value is string {
  return typeof value === "string" && MATRIX_BILLING_SERVER_PROFILES.some(
    (profile) => profile.hetznerType.toLowerCase() === value.toLowerCase(),
  );
}

export function isServerTypeAllowedForEntitlement(
  serverType: unknown,
  allowedServerTypes: readonly string[],
): serverType is string {
  return isKnownServerType(serverType) && allowedServerTypes.some(
    (allowedServerType) => allowedServerType.toLowerCase() === serverType.toLowerCase(),
  );
}

function isKnownLocation(value: unknown): value is string {
  return typeof value === "string" && MATRIX_BILLING_REGIONS.some(
    (region) => region.location === value,
  );
}

function safeReadDraft(): AddComputerDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ADD_COMPUTER_DRAFT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AddComputerDraft>;
    if (
      typeof value.name !== "string" ||
      typeof value.slot !== "string" ||
      value.name.trim().length === 0 ||
      value.name.trim().length > 32 ||
      value.slot === "primary" ||
      value.slot !== normalizeRuntimeSlotName(value.name) ||
      !Array.isArray(value.developerTools) ||
      !value.developerTools.every(isDeveloperToolId) ||
      !isKnownServerType(value.serverType) ||
      !isKnownLocation(value.location) ||
      typeof value.baselineMaxRuntimeSlots !== "number" ||
      !Number.isInteger(value.baselineMaxRuntimeSlots) ||
      value.baselineMaxRuntimeSlots < 0
    ) {
      return null;
    }
    const now = Date.now();
    const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt <= now
      ? value.createdAt
      : now;
    return {
      name: value.name,
      slot: value.slot,
      developerTools: value.developerTools as DeveloperToolId[],
      serverType: value.serverType.toLowerCase(),
      location: value.location,
      baselineMaxRuntimeSlots: value.baselineMaxRuntimeSlots,
      createdAt,
    };
  } catch (error: unknown) {
    console.warn("[runtime-manager] unable to read add-computer draft", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

function safeWriteDraft(draft: AddComputerDraft): boolean {
  try {
    window.sessionStorage.setItem(ADD_COMPUTER_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch (error: unknown) {
    console.warn("[runtime-manager] unable to persist add-computer draft", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

function safeClearDraft(): void {
  try {
    window.sessionStorage.removeItem(ADD_COMPUTER_DRAFT_KEY);
  } catch (error: unknown) {
    console.warn("[runtime-manager] unable to clear add-computer draft", error instanceof Error ? error.name : typeof error);
  }
}

async function fetchJson(input: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(input, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch (error: unknown) {
    capturePostHogLog("warn", "runtime_manager response_parse_failed", {
      surface: "runtime_manager",
      error_kind: error instanceof Error ? error.name : typeof error,
    });
  }
  return { response, body };
}

function parseBillingStatus(value: unknown): BillingStatus | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { entitlement?: unknown; access?: unknown };
  if (!candidate.access || typeof candidate.access !== "object") return null;
  const access = candidate.access as { runtimeProxyAllowed?: unknown; reason?: unknown };
  if (typeof access.runtimeProxyAllowed !== "boolean" || typeof access.reason !== "string") return null;
  if (candidate.entitlement === null || candidate.entitlement === undefined) {
    return { entitlement: null, access: { runtimeProxyAllowed: access.runtimeProxyAllowed, reason: access.reason } };
  }
  if (typeof candidate.entitlement !== "object") return null;
  const entitlement = candidate.entitlement as Partial<BillingEntitlement>;
  const stringOrNull = (value: unknown) => value === null || typeof value === "string";
  if (
    (entitlement.source !== "stripe" && entitlement.source !== "override") ||
    !["matrix_starter", "matrix_builder", "matrix_max", "internal"].includes(entitlement.planSlug ?? "") ||
    typeof entitlement.status !== "string" ||
    !Number.isInteger(entitlement.maxRuntimeSlots) ||
    (entitlement.maxRuntimeSlots ?? -1) < 0 ||
    !Number.isInteger(entitlement.includedRuntimeSlots) ||
    !Number.isInteger(entitlement.addonRuntimeSlots) ||
    typeof entitlement.defaultServerType !== "string" ||
    !Array.isArray(entitlement.allowedServerTypes) ||
    entitlement.allowedServerTypes.length > 10 ||
    !entitlement.allowedServerTypes.every((serverType) => typeof serverType === "string") ||
    !stringOrNull(entitlement.stripeSubscriptionId) ||
    !stringOrNull(entitlement.stripePriceId) ||
    !stringOrNull(entitlement.gracePeriodEndsAt) ||
    typeof entitlement.effectiveFrom !== "string" ||
    !stringOrNull(entitlement.effectiveUntil) ||
    typeof entitlement.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    entitlement: entitlement as BillingEntitlement,
    access: { runtimeProxyAllowed: access.runtimeProxyAllowed, reason: access.reason },
  };
}

function parseJourneyState(value: unknown): JourneyState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { phase?: unknown; progress?: unknown; failure?: unknown };
  if (
    typeof candidate.phase !== "string" ||
    !["provisioning", "provisioning_failed", "ready", "first_run"].includes(candidate.phase)
  ) {
    return null;
  }
  let progress: JourneyState["progress"];
  if (candidate.progress !== undefined) {
    if (!candidate.progress || typeof candidate.progress !== "object") return null;
    const progressCandidate = candidate.progress as { stage?: unknown; startedAt?: unknown };
    if (
      typeof progressCandidate.stage !== "string" ||
      !["creating_server", "booting", "registering", "finalizing"].includes(progressCandidate.stage) ||
      typeof progressCandidate.startedAt !== "string" ||
      progressCandidate.startedAt.length > 64
    ) {
      return null;
    }
    progress = progressCandidate as JourneyState["progress"];
  }
  let failure: JourneyState["failure"];
  if (candidate.failure !== undefined) {
    if (!candidate.failure || typeof candidate.failure !== "object") return null;
    const failureCandidate = candidate.failure as { retryable?: unknown; attempt?: unknown };
    if (
      typeof failureCandidate.retryable !== "boolean" ||
      typeof failureCandidate.attempt !== "number" ||
      !Number.isInteger(failureCandidate.attempt) ||
      failureCandidate.attempt < 0 ||
      failureCandidate.attempt > 100
    ) {
      return null;
    }
    failure = failureCandidate as JourneyState["failure"];
  }
  const detail = candidate.phase === "provisioning_failed"
    ? "Build paused. Your existing computers were not changed."
    : candidate.phase === "ready" || candidate.phase === "first_run"
      ? "Your computer is ready."
      : "Creating a private Matrix OS computer with its own files and data.";
  return { phase: candidate.phase, detail, ...(progress ? { progress } : {}), ...(failure ? { failure } : {}) };
}

async function readOverview(): Promise<{ inventory: MatrixComputerList; billing: BillingStatus }> {
  const [computerResult, billingResult] = await Promise.all([
    fetchJson("/api/auth/computers"),
    fetchJson("/billing/status"),
  ]);
  if (!computerResult.response.ok || !billingResult.response.ok) throw new Error("overview_unavailable");
  const inventory = MatrixComputerListSchema.safeParse(computerResult.body);
  const billing = parseBillingStatus(billingResult.body);
  if (!inventory.success || !billing) throw new Error("overview_invalid");
  return { inventory: inventory.data, billing };
}

function activeCustomerCount(inventory: MatrixComputerList): number {
  return inventory.items.filter((computer) => computer.kind === "customer").length;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- This finite-state orchestration root delegates every screen to focused view components; keeping shared billing and provisioning transitions together avoids duplicated or divergent flow state.
export function RuntimeManager({
  onExternalNavigate,
  billingPollIntervalMs = DEFAULT_BILLING_POLL_INTERVAL_MS,
  journeyPollIntervalMs = DEFAULT_JOURNEY_POLL_INTERVAL_MS,
}: RuntimeManagerProps) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [initialFlow] = useState(() => {
    const storedDraft = safeReadDraft();
    const newComputerIntent = hasNewComputerIntent();
    return {
      draft: storedDraft,
      step: storedDraft && newComputerIntent ? "billing_wait" : newComputerIntent ? "name" : "list",
    } satisfies { draft: AddComputerDraft | null; step: FlowStep };
  });
  const [draft, setDraft] = useState<AddComputerDraft | null>(initialFlow.draft);
  const [step, setStep] = useState<FlowStep>(initialFlow.step);
  const [overview, setOverview] = useState<OverviewState>({ status: "loading", inventory: null, billing: null });
  const [overviewRefresh, setOverviewRefresh] = useState(0);
  const [computerName, setComputerName] = useState(initialFlow.draft?.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [safeError, setSafeError] = useState<string | null>(null);
  const [journey, setJourney] = useState<JourneyState | null>(null);
  const [journeyRefresh, setJourneyRefresh] = useState(0);
  const errorRetryActionRef = useRef<ErrorRetryAction>("provision");
  const resumeProvisionStartedRef = useRef(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this authenticated client inventory depends on Clerk state; the disposed guard prevents stale writes after refresh or unmount.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let disposed = false;
    readOverview()
      .then((value) => {
        if (!disposed) setOverview({ status: "ready", ...value });
      })
      .catch((error: unknown) => {
        capturePostHogLog("error", "runtime_manager overview_failed", {
          surface: "runtime_manager",
          error_kind: error instanceof Error ? error.message : typeof error,
        });
        if (!disposed) setOverview({ status: "error", inventory: null, billing: null });
      });
    return () => {
      disposed = true;
    };
  }, [isLoaded, isSignedIn, overviewRefresh]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.RUNTIME_MANAGER_VIEWED, { entry: hasNewComputerIntent() ? "new" : "manager" });
  }, [isLoaded, isSignedIn]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this bounded poll waits for the signed Stripe webhook projection; each iteration owns and clears its timer.
  useEffect(() => {
    if (step !== "billing_wait" || !draft || resumeProvisionStartedRef.current) return;
    const currentMax = overview.status === "ready" ? overview.billing.entitlement?.maxRuntimeSlots ?? 0 : 0;
    if (overview.status === "ready" && currentMax > draft.baselineMaxRuntimeSlots) {
      resumeProvisionStartedRef.current = true;
      void provisionComputer(draft, setStep, setJourney, setSafeError, setJourneyRefresh, setErrorRetryAction);
      return;
    }
    const projectionWaitRemaining = Math.max(0, BILLING_PROJECTION_WAIT_MS - (Date.now() - draft.createdAt));
    const timeoutId = window.setTimeout(() => {
      if (projectionWaitRemaining === 0) {
        setSafeError("Your subscription update is taking longer than expected. You can try again without losing your computer name.");
        setErrorRetryAction("billing");
        setStep("error");
        return;
      }
      setOverviewRefresh((value) => value + 1);
    }, Math.min(billingPollIntervalMs, projectionWaitRemaining));
    return () => window.clearTimeout(timeoutId);
  }, [billingPollIntervalMs, draft, overview, step]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- slot-specific journey polling is client-authenticated, bounded to one timer, and cancelled on cleanup.
  useEffect(() => {
    if (step !== "provisioning" || !draft) return;
    let disposed = false;
    let retryTimeoutId: number | undefined;
    const scheduleRetry = () => {
      if (!disposed) {
        retryTimeoutId = window.setTimeout(() => setJourneyRefresh((value) => value + 1), journeyPollIntervalMs);
      }
    };
    fetchJson(`/api/journey?runtimeSlot=${encodeURIComponent(draft.slot)}`)
      .then(({ response, body }) => {
        if (disposed) return;
        if (!response.ok || !body || typeof body !== "object") {
          scheduleRetry();
          return;
        }
        const nextJourney = parseJourneyState(body);
        if (!nextJourney) {
          capturePostHogLog("warn", "runtime_manager journey_projection_invalid", {
            surface: "runtime_manager",
          });
          scheduleRetry();
          return;
        }
        setJourney(nextJourney);
        if (nextJourney.phase === "ready" || nextJourney.phase === "first_run") {
          safeClearDraft();
          capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_COMPLETED, { result: "ready" });
          setStep("ready");
          setOverviewRefresh((value) => value + 1);
          return;
        }
        if (nextJourney.phase === "provisioning_failed") {
          capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_FAILED, { stage: "provisioning" });
          return;
        }
        scheduleRetry();
      })
      .catch((error: unknown) => {
        capturePostHogLog("warn", "runtime_manager journey_poll_failed", {
          surface: "runtime_manager",
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        scheduleRetry();
      });
    return () => {
      disposed = true;
      if (retryTimeoutId !== undefined) window.clearTimeout(retryTimeoutId);
    };
  }, [draft, journeyPollIntervalMs, journeyRefresh, step]);

  if (!isLoaded) return <RuntimeLoading />;
  if (!isSignedIn) return <RedirectToSignIn />;

  const displayName = user?.fullName ?? user?.username ?? "Matrix OS member";
  const email = user?.primaryEmailAddress?.emailAddress ?? "Email unavailable";
  const avatarUrl = user?.imageUrl || null;
  const inventory = overview.status === "ready" ? overview.inventory : null;
  const validation = validateRuntimeName(computerName, inventory?.items.map((computer) => computer.runtimeSlot) ?? []);
  const title = draft ? runtimeSlotTitle(draft.slot) : validation.valid ? validation.title : "New computer";

  function beginAddComputer(): void {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_INTENT, { source: "runtime_manager" });
    setNameError(null);
    setSafeError(null);
    setStep("name");
  }

  function continueFromName(): void {
    if (overview.status !== "ready") {
      setNameError("Wait for your computers to finish loading before continuing.");
      return;
    }
    if (!validation.valid) {
      setNameError(validation.error);
      return;
    }
    setNameError(null);
    setDraft({
      name: computerName.trim(),
      slot: validation.slot,
      developerTools: [],
      serverType: overview.billing.entitlement?.defaultServerType.toLowerCase() ?? "cpx22",
      location: MATRIX_BILLING_REGIONS[0]?.location ?? "fsn1",
      baselineMaxRuntimeSlots: overview.billing.entitlement?.maxRuntimeSlots ?? 0,
      createdAt: Date.now(),
    });
    setStep("configuration");
  }

  function continueFromConfiguration(selection: ComputerSetupSelection): void {
    const allowedServerTypes = overview.status === "ready"
      ? overview.billing.entitlement?.allowedServerTypes ?? []
      : [];
    if (
      !draft ||
      !isServerTypeAllowedForEntitlement(selection.serverType, allowedServerTypes) ||
      !isKnownLocation(selection.location)
    ) return;
    setDraft({
      ...draft,
      serverType: selection.serverType.toLowerCase(),
      location: selection.location,
    });
    setStep("installs");
  }

  function setErrorRetryAction(action: ErrorRetryAction): void {
    errorRetryActionRef.current = action;
  }

  async function buildComputer(draftOverride?: AddComputerDraft): Promise<void> {
    const currentDraft = draftOverride ?? draft;
    if (!currentDraft) return;
    if (overview.status !== "ready") {
      setSafeError("Your computer inventory is still loading. Try again in a moment.");
      setErrorRetryAction("billing");
      setStep("error");
      return;
    }
    const nextDraft = currentDraft;
    setDraft(nextDraft);
    const entitlement = overview.billing.entitlement;
    const capacityAvailable = Boolean(entitlement && activeCustomerCount(overview.inventory) < entitlement.maxRuntimeSlots);
    if (capacityAvailable) {
      await provisionComputer(nextDraft, setStep, setJourney, setSafeError, setJourneyRefresh, setErrorRetryAction);
      return;
    }
    if (entitlement?.source === "override") {
      setSafeError("This account is managed internally. Ask your Matrix administrator to add computer capacity.");
      setStep("managed");
      return;
    }
    if (entitlement?.source !== "stripe" || !entitlement.stripeSubscriptionId) {
      setSafeError("Computer capacity is unavailable right now. Try again in a moment.");
      setErrorRetryAction("billing");
      setStep("error");
      return;
    }
    if (!safeWriteDraft(nextDraft)) {
      setSafeError("We could not safely save this setup before opening billing. Try again.");
      setErrorRetryAction("billing");
      setStep("error");
      return;
    }
    try {
      const { response, body } = await fetchJson("/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "add_computer", returnPath: "/runtime?new=1" }),
      });
      const url = body && typeof body === "object" && typeof (body as { url?: unknown }).url === "string"
        ? (body as { url: string }).url
        : null;
      if (!response.ok || !url) {
        capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_FAILED, { stage: "billing_handoff" });
        capturePostHogLog("error", "runtime_manager billing_handoff_failed", {
          surface: "runtime_manager",
          error_kind: "portal_unavailable",
        });
        setSafeError("Billing is unavailable right now. Your computer setup is saved; try again in a moment.");
        setErrorRetryAction("billing");
        setStep("error");
        return;
      }
      capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_BILLING_HANDOFF, { result: "portal_created" });
      (onExternalNavigate ?? ((target: string) => window.location.assign(target)))(url);
    } catch (error: unknown) {
      capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_FAILED, { stage: "billing_handoff" });
      capturePostHogLog("error", "runtime_manager billing_handoff_failed", {
        surface: "runtime_manager",
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      setSafeError("Billing is unavailable right now. Your computer setup is saved; try again in a moment.");
      setErrorRetryAction("billing");
      setStep("error");
    }
  }

  async function retryJourney(): Promise<void> {
    if (!draft) return;
    try {
      const { response } = await fetchJson("/api/journey/retry-provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeSlot: draft.slot }),
      });
      if (response.status === 402) {
        setStep("installs");
        return;
      }
      if (!response.ok) {
        capturePostHogLog("error", "runtime_manager retry_failed", {
          surface: "runtime_manager",
          error_kind: "retry_unavailable",
        });
        setSafeError("We could not retry building this computer. Try again in a moment.");
        setErrorRetryAction("journey");
        setStep("error");
        return;
      }
      setJourney(null);
      setStep("provisioning");
      setJourneyRefresh((value) => value + 1);
    } catch (error: unknown) {
      capturePostHogLog("error", "runtime_manager retry_failed", {
        surface: "runtime_manager",
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      setSafeError("We could not retry building this computer. Try again in a moment.");
      setErrorRetryAction("journey");
      setStep("error");
    }
  }

  async function handleSignOut(): Promise<void> {
    try {
      await fetchJson("/api/auth/app-session", { method: "DELETE" });
    } catch (error: unknown) {
      console.warn("[runtime-manager] app session cleanup failed", error instanceof Error ? error.name : typeof error);
    }
    try {
      await signOut({ redirectUrl: "/sign-in" });
    } catch (error: unknown) {
      capturePostHogLog("error", "runtime_manager sign_out_failed", {
        surface: "runtime_manager",
        error_kind: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return (
    <main className="relative isolate h-dvh overflow-y-auto bg-[#DFE0D8] font-sans text-deep">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <Image
          src={platformShellAssetPath("/runtime-shell-backdrop.webp")}
          alt=""
          fill
          priority
          unoptimized
          sizes="100vw"
          data-testid="runtime-shell-backdrop"
          className="scale-[1.08] select-none object-cover blur-[18px] brightness-[0.78] saturate-[0.85]"
        />
      </div>
      <div
        className="pointer-events-none fixed inset-0 z-[1] bg-[rgba(244,242,232,0.58)]"
        aria-hidden="true"
      />
      <Image
        src={platformShellAssetPath("/logo-rabbit.png")}
        alt=""
        width={623}
        height={666}
        priority
        unoptimized
        aria-hidden="true"
        data-testid="runtime-rabbit-shadow"
        className="pointer-events-none fixed left-1/2 top-1/2 z-[2] w-[min(156vw,68rem)] -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.045] blur-[0.4px]"
      />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-10">
        <section className="flex flex-1 flex-col pb-28 pt-4 sm:pt-2">
          {step === "list" ? (
            <ComputerInventory overview={overview} onRetry={() => setOverviewRefresh((value) => value + 1)} onAdd={beginAddComputer} />
          ) : null}
          {step === "name" ? (
            <NameStep
              value={computerName}
              normalizedSlot={validation.slot}
              error={nameError}
              onChange={setComputerName}
              onBack={() => setStep("list")}
              onContinue={continueFromName}
            />
          ) : null}
          {step === "configuration" && draft && overview.status === "ready" ? (
            <div className="mx-auto w-full max-w-4xl">
              <button
                type="button"
                onClick={() => setStep("name")}
                className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-forest/65 hover:text-forest"
              >
                <ArrowLeftIcon className="size-4" aria-hidden="true" /> Back
              </button>
              <BillingPanel
                active={overview.billing.access.runtimeProxyAllowed}
                entitlement={overview.billing.entitlement}
                accessReason={overview.billing.access.reason}
                mode="add-computer"
                onComputerSetupContinue={continueFromConfiguration}
              />
            </div>
          ) : null}
          {step === "installs" ? (
            <div className="mx-auto w-full max-w-4xl">
              <button
                type="button"
                onClick={() => setStep("configuration")}
                className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-forest/65 hover:text-forest"
              >
                <ArrowLeftIcon className="size-4" aria-hidden="true" /> Back
              </button>
              <DefaultInstallsStep
                onBuild={(developerTools) => {
                  if (!draft) return;
                  const nextDraft = { ...draft, developerTools };
                  setDraft(nextDraft);
                  void buildComputer(nextDraft);
                }}
              />
            </div>
          ) : null}
          {step === "billing_wait" ? <BillingWait title={title} /> : null}
          {step === "provisioning" ? (
            <ProvisioningStep
              title={title}
              journey={journey}
              onRetry={() => void retryJourney()}
              onBack={() => {
                safeClearDraft();
                setDraft(null);
                setJourney(null);
                setStep("list");
                setOverviewRefresh((value) => value + 1);
              }}
            />
          ) : null}
          {step === "ready" && draft ? (
            <ReadyStep
              title={title}
              computer={overview.status === "ready" ? overview.inventory.items.find((item) => item.runtimeSlot === draft.slot) : undefined}
              onReturn={() => setStep("list")}
            />
          ) : null}
          {step === "managed" || step === "error" ? (
            <ErrorStep
              message={safeError ?? "Computer setup is unavailable right now."}
              managed={step === "managed"}
              onRetry={() => {
                setSafeError(null);
                if (step === "managed") setStep("installs");
                else if (!draft) setStep("list");
                else if (errorRetryActionRef.current === "billing") {
                  const refreshedDraft = { ...draft, createdAt: Date.now() };
                  resumeProvisionStartedRef.current = false;
                  setDraft(refreshedDraft);
                  safeWriteDraft(refreshedDraft);
                  void buildComputer(refreshedDraft);
                } else if (errorRetryActionRef.current === "journey") {
                  void retryJourney();
                } else {
                  void provisionComputer(draft, setStep, setJourney, setSafeError, setJourneyRefresh, setErrorRetryAction);
                }
              }}
              onBack={() => setStep("list")}
            />
          ) : null}
        </section>

        <section
          className="fixed bottom-4 left-4 mt-0 flex w-fit max-w-[calc(100vw-2rem)] min-w-0 flex-row items-center gap-3 rounded-2xl border border-white/70 bg-white/55 p-2 shadow-[0_18px_55px_rgba(50,53,46,0.08)] backdrop-blur-xl md:bottom-7 md:left-7"
          aria-label="Account"
        >
          <div className="flex min-w-0 items-center gap-3 px-1 sm:px-0">
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-forest text-white ring-2 ring-white/80">
              {avatarUrl ? (
                <Image src={avatarUrl} alt="" width={36} height={36} className="size-full object-cover" unoptimized />
              ) : (
                <UserIcon className="size-4" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 max-w-36 sm:max-w-44">
              <strong className="block truncate text-xs font-medium tracking-[-0.01em]">{displayName}</strong>
              <span className="block truncate text-[11px] text-forest/50">{email}</span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => clerk.openUserProfile()}
              className="account-action size-9 min-h-0 shrink-0 p-0"
              aria-label="Manage account"
              title="Manage account"
            >
              <SettingsIcon className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="account-action size-9 min-h-0 shrink-0 p-0"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOutIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

async function provisionComputer(
  draft: AddComputerDraft,
  setStep: (step: FlowStep) => void,
  setJourney: (journey: JourneyState | null) => void,
  setSafeError: (error: string | null) => void,
  setJourneyRefresh: React.Dispatch<React.SetStateAction<number>>,
  setErrorRetryAction: (action: ErrorRetryAction) => void,
): Promise<void> {
  setSafeError(null);
  capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_PROVISIONING_STARTED, { developer_tools_count: draft.developerTools.length });
  try {
    const { response } = await fetchJson("/api/auth/provision-runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: draft.slot,
        developerTools: draft.developerTools,
        serverType: draft.serverType,
        location: draft.location,
      }),
    });
    if (response.status === 402) {
      setStep("installs");
      return;
    }
    if (response.status === 409) {
      setSafeError("That computer name is already in use. Choose another name.");
      setStep("name");
      return;
    }
    if (!response.ok) throw new Error("provision_unavailable");
    safeWriteDraft(draft);
    setJourney(null);
    setStep("provisioning");
    setJourneyRefresh((value) => value + 1);
  } catch (error: unknown) {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ADD_COMPUTER_FAILED, { stage: "provisioning_start" });
    capturePostHogLog("error", "runtime_manager provision_failed", {
      surface: "runtime_manager",
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    setSafeError("We could not start building this computer. Try again in a moment.");
    setErrorRetryAction("provision");
    setStep("error");
  }
}
