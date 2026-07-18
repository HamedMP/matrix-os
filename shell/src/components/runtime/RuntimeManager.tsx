"use client";

import { RedirectToSignIn, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { BrandCard, Eyebrow, palette as brand, StatusPill } from "@matrix-os/brand";
import { MatrixComputerListSchema, type MatrixComputer, type MatrixComputerList } from "@matrix-os/contracts";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  CloudIcon,
  ExternalLinkIcon,
  HardDriveIcon,
  Loader2Icon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  UserIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  defaultDeveloperTools,
  nextDeveloperToolsSelection,
  type DeveloperToolId,
} from "@/components/onboarding/developer-tools";
import { DeveloperToolsSelector } from "@/components/onboarding/DefaultInstallsStep";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { normalizeRuntimeSlotName, runtimeSlotTitle, validateRuntimeName } from "./runtime-name";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BILLING_POLL_INTERVAL_MS = 3_000;
const DEFAULT_JOURNEY_POLL_INTERVAL_MS = 3_000;
const BILLING_PROJECTION_WAIT_MS = 2 * 60_000;
export const ADD_COMPUTER_DRAFT_KEY = "matrix:add-computer-draft:v1";

type BillingEntitlement = {
  source: "stripe" | "override";
  planSlug: "matrix_starter" | "matrix_builder" | "matrix_max" | "internal";
  status: string;
  maxRuntimeSlots: number;
  stripeSubscriptionId: string | null;
};

type BillingStatus = {
  entitlement: BillingEntitlement | null;
  access: { runtimeProxyAllowed: boolean; reason: string };
};

type JourneyState = {
  phase: "provisioning" | "provisioning_failed" | "ready" | "first_run" | string;
  detail: string;
  progress?: { stage: "creating_server" | "booting" | "registering" | "finalizing"; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
};

type AddComputerDraft = {
  name: string;
  slot: string;
  developerTools: DeveloperToolId[];
  baselineMaxRuntimeSlots: number;
  createdAt: number;
};

type OverviewState =
  | { status: "loading"; inventory: null; billing: null }
  | { status: "ready"; inventory: MatrixComputerList; billing: BillingStatus }
  | { status: "error"; inventory: null; billing: null };

type FlowStep =
  | "list"
  | "name"
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
  if (
    (entitlement.source !== "stripe" && entitlement.source !== "override") ||
    !["matrix_starter", "matrix_builder", "matrix_max", "internal"].includes(entitlement.planSlug ?? "") ||
    typeof entitlement.status !== "string" ||
    !Number.isInteger(entitlement.maxRuntimeSlots) ||
    (entitlement.maxRuntimeSlots ?? -1) < 0 ||
    (entitlement.stripeSubscriptionId !== null && typeof entitlement.stripeSubscriptionId !== "string")
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

function journeyStageLabel(stage: NonNullable<JourneyState["progress"]>["stage"]): string {
  if (stage === "creating_server") return "Creating server";
  if (stage === "booting") return "Booting";
  if (stage === "registering") return "Registering";
  if (stage === "finalizing") return "Finalizing";
  return "Building";
}

function activeCustomerCount(inventory: MatrixComputerList): number {
  return inventory.items.filter((computer) => computer.kind === "customer").length;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- this is the single add-computer orchestration state machine; all visual steps are already extracted below, and splitting the coordinator would replace local transitions with a wide callback prop surface.
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
  const [selectedTools, setSelectedTools] = useState<DeveloperToolId[]>(initialFlow.draft?.developerTools ?? defaultDeveloperTools);
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
    if (step !== "billing_wait" || !draft || overview.status !== "ready" || resumeProvisionStartedRef.current) return;
    const currentMax = overview.billing.entitlement?.maxRuntimeSlots ?? 0;
    if (currentMax > draft.baselineMaxRuntimeSlots) {
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
      developerTools: selectedTools,
      baselineMaxRuntimeSlots: overview.billing.entitlement?.maxRuntimeSlots ?? 0,
      createdAt: Date.now(),
    });
    setStep("installs");
  }

  function toggleTool(tool: DeveloperToolId): void {
    setSelectedTools((current) => nextDeveloperToolsSelection(current, tool));
  }

  function setErrorRetryAction(action: ErrorRetryAction): void {
    errorRetryActionRef.current = action;
  }

  async function buildComputer(): Promise<void> {
    if (!draft) return;
    if (overview.status !== "ready") {
      setSafeError("Your computer inventory is still loading. Try again in a moment.");
      setErrorRetryAction("billing");
      setStep("error");
      return;
    }
    const nextDraft = { ...draft, developerTools: selectedTools };
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
    <main
      className="h-dvh overflow-y-auto bg-page-bg text-deep"
      style={{ background: `radial-gradient(circle at 12% 0%, ${brand.cream} 0, transparent 38%), ${brand.pageBg}` }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-5 sm:px-7 sm:py-8 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-forest/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-forest no-underline">
            <span className="grid size-8 place-items-center rounded-xl bg-forest text-white">M</span>
            Matrix OS
          </Link>
          <section className="flex min-w-0 flex-wrap items-center gap-3" aria-label="Account">
            <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-forest text-white">
              {avatarUrl ? (
                <Image src={avatarUrl} alt="" width={44} height={44} className="size-full object-cover" unoptimized />
              ) : (
                <UserIcon className="size-5" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 grow sm:grow-0">
              <strong className="block truncate text-sm">{displayName}</strong>
              <span className="block truncate text-xs text-forest/55">{email}</span>
            </span>
            <button type="button" onClick={() => clerk.openUserProfile()} className="account-action">Manage account</button>
            <button type="button" onClick={() => void handleSignOut()} className="account-action">
              <LogOutIcon className="size-3.5" aria-hidden="true" /> Sign out
            </button>
          </section>
        </header>

        <section className="flex flex-1 flex-col py-8 sm:py-12">
          {step === "list" ? (
            <ComputerInventory overview={overview} onRetry={() => setOverviewRefresh((value) => value + 1)} onAdd={beginAddComputer} />
          ) : null}
          {step === "name" ? (
            <NameStep
              value={computerName}
              normalizedSlot={validation.valid ? validation.slot : validation.slot}
              error={nameError}
              onChange={setComputerName}
              onBack={() => setStep("list")}
              onContinue={continueFromName}
            />
          ) : null}
          {step === "installs" ? (
            <InstallsStep
              title={title}
              selectedTools={selectedTools}
              onToggle={toggleTool}
              onBack={() => setStep("name")}
              onBuild={() => void buildComputer()}
            />
          ) : null}
          {step === "billing_wait" ? <BillingWait title={title} /> : null}
          {step === "provisioning" ? (
            <ProvisioningStep title={title} journey={journey} onRetry={() => void retryJourney()} />
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
                  void buildComputer();
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
      body: JSON.stringify({ runtime: draft.slot, developerTools: draft.developerTools }),
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

function RuntimeLoading() {
  return (
    <main className="grid h-dvh place-items-center bg-page-bg text-forest" aria-busy="true">
      <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading your computers</span>
    </main>
  );
}

function ComputerInventory({
  overview,
  onRetry,
  onAdd,
}: {
  overview: OverviewState;
  onRetry: () => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Computer manager</Eyebrow>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-deep sm:text-5xl">Your computers</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-forest/65 sm:text-base">
            Open a computer, check its build, or create another independent Matrix OS workspace.
          </p>
        </div>
        <button type="button" onClick={onAdd} className="primary-action">
          <PlusIcon className="size-4" aria-hidden="true" /> Get another computer
        </button>
      </div>

      {overview.status === "loading" ? (
        <div className="mt-9 grid gap-4 md:grid-cols-2" aria-label="Loading computers" aria-busy="true">
          {[0, 1].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl bg-white/60" />)}
        </div>
      ) : null}
      {overview.status === "error" ? (
        <BrandCard className="mt-9 p-6">
          <CircleAlertIcon className="size-7 text-ember" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-semibold">Computers are temporarily unavailable</h2>
          <p className="mt-2 text-sm text-forest/65">Nothing was changed. Try loading your computer list again.</p>
          <button type="button" onClick={onRetry} className="secondary-action mt-5">
            <RefreshCwIcon className="size-4" aria-hidden="true" /> Try again
          </button>
        </BrandCard>
      ) : null}
      {overview.status === "ready" ? (
        overview.inventory.items.length > 0 ? (
          <div className="mt-9 grid gap-4 md:grid-cols-2" aria-label="Matrix OS computers">
            {overview.inventory.items.map((computer) => (
              <ComputerCard key={computer.runtimeSlot} computer={computer} current={computer.runtimeSlot === overview.inventory.selectedSlot} />
            ))}
          </div>
        ) : (
          <BrandCard className="mt-9 flex flex-col items-center p-8 text-center">
            <ServerIcon className="size-9 text-forest/55" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold">Build your first computer</h2>
            <p className="mt-2 max-w-md text-sm text-forest/65">Choose a name and default installs to begin.</p>
            <button type="button" onClick={onAdd} className="primary-action mt-5">Get a computer</button>
          </BrandCard>
        )
      ) : null}
    </div>
  );
}

function ComputerCard({ computer, current }: { computer: MatrixComputer; current: boolean }) {
  const title = computer.runtimeSlot === "primary" ? "Main Computer" : runtimeSlotTitle(computer.runtimeSlot);
  const available = computer.availability === "available";
  const tone = available ? "ready" : "pending";
  return (
    <BrandCard className="flex min-h-56 flex-col p-5 sm:p-6" style={current ? { borderColor: brand.ember } : undefined}>
      <div className="flex items-start justify-between gap-4">
        <span className="grid size-11 place-items-center rounded-2xl bg-forest/[0.08] text-forest">
          {computer.kind === "preview" ? <CloudIcon className="size-5" aria-hidden="true" /> : <HardDriveIcon className="size-5" aria-hidden="true" />}
        </span>
        <StatusPill tone={tone}>{computer.availability === "available" ? "Ready" : computer.availability === "starting" ? "Building" : "Unavailable"}</StatusPill>
      </div>
      <div className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {current ? <span className="rounded-full bg-ember/10 px-2 py-1 text-[11px] font-semibold text-ember">Current computer</span> : null}
        </div>
        <p className="mt-1 text-sm text-forest/55">{computer.label} · {computer.runtimeSlot}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-6">
        <span className="text-xs font-medium text-forest/50">{computer.versionLabel ?? "Version pending"}</span>
        {available ? (
          <a className="secondary-action" href={computer.gatewayPath} aria-label={`Open ${title}`}>
            Open computer <ChevronRightIcon className="size-4" aria-hidden="true" />
          </a>
        ) : (
          <span className="text-xs font-semibold text-forest/45">Check again soon</span>
        )}
      </div>
    </BrandCard>
  );
}

function StepFrame({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      {onBack ? (
        <button type="button" onClick={onBack} className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-forest/65 hover:text-forest">
          <ArrowLeftIcon className="size-4" aria-hidden="true" /> Back
        </button>
      ) : null}
      {children}
    </div>
  );
}

function NameStep({
  value,
  normalizedSlot,
  error,
  onChange,
  onBack,
  onContinue,
}: {
  value: string;
  normalizedSlot: string;
  error: string | null;
  onChange: (value: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <StepFrame onBack={onBack}>
      <BrandCard className="p-6 sm:p-9">
        <Eyebrow>New computer · 1 of 2</Eyebrow>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Name your computer</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-forest/65">
          Give this computer a short name. We’ll turn it into a safe slot used only inside your account.
        </p>
        <label className="mt-7 block text-sm font-semibold" htmlFor="computer-name">Computer name</label>
        <input
          id="computer-name"
          value={value}
          maxLength={64}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Design Studio"
          aria-describedby="normalized-name name-error"
          className="mt-2 h-12 w-full rounded-xl border border-forest/15 bg-white px-4 text-base outline-none transition focus:border-ember focus:ring-2 focus:ring-ember/15"
        />
        <p id="normalized-name" className="mt-2 min-h-5 text-xs text-forest/50">
          Slot: <code className="rounded bg-forest/[0.06] px-1.5 py-0.5">{normalizedSlot || "computer-name"}</code>
        </p>
        {error ? <p id="name-error" className="mt-3 rounded-xl bg-ember/10 px-3 py-2 text-sm text-deep" role="alert">{error}</p> : null}
        <div className="mt-7 flex justify-end">
          <button type="button" onClick={onContinue} className="primary-action">Continue <ChevronRightIcon className="size-4" aria-hidden="true" /></button>
        </div>
      </BrandCard>
    </StepFrame>
  );
}

function InstallsStep({
  title,
  selectedTools,
  onToggle,
  onBack,
  onBuild,
}: {
  title: string;
  selectedTools: DeveloperToolId[];
  onToggle: (tool: DeveloperToolId) => void;
  onBack: () => void;
  onBuild: () => void;
}) {
  return (
    <StepFrame onBack={onBack}>
      <BrandCard className="p-6 sm:p-9">
        <Eyebrow>New computer · 2 of 2</Eyebrow>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Choose default installs</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-forest/65">
          {title} is a fresh computer with independent files and data. Your account stays the same, but apps and tools install separately.
        </p>
        <div className="mt-7">
          <DeveloperToolsSelector selectedTools={selectedTools} onToggle={onToggle} />
        </div>
        <div className="mt-7 flex justify-end">
          <button type="button" onClick={onBuild} className="primary-action">
            <ServerIcon className="size-4" aria-hidden="true" /> Build computer
          </button>
        </div>
      </BrandCard>
    </StepFrame>
  );
}

function BillingWait({ title }: { title: string }) {
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12" aria-live="polite">
        <Loader2Icon className="mx-auto size-9 animate-spin text-ember" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold">Confirming computer capacity</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-forest/65">
          We’re waiting for Stripe’s signed update before building {title}. The redirect alone never starts provisioning.
        </p>
      </BrandCard>
    </StepFrame>
  );
}

function ProvisioningStep({ title, journey, onRetry }: { title: string; journey: JourneyState | null; onRetry: () => void }) {
  const failed = journey?.phase === "provisioning_failed";
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12" aria-live="polite">
        {failed ? <CircleAlertIcon className="mx-auto size-9 text-ember" aria-hidden="true" /> : <Loader2Icon className="mx-auto size-9 animate-spin text-ember" aria-hidden="true" />}
        <h1 className="mt-5 text-2xl font-semibold">{failed ? `Build paused for ${title}` : `Building ${title}`}</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-forest/65">
          {journey?.detail ?? "Creating a private Matrix OS computer with its own files and data."}
        </p>
        {!failed ? <p className="mt-5 text-sm font-semibold text-forest">{journey?.progress ? journeyStageLabel(journey.progress.stage) : "Starting build"}</p> : null}
        {failed && journey.failure?.retryable ? (
          <button type="button" onClick={onRetry} className="primary-action mt-6"><RefreshCwIcon className="size-4" aria-hidden="true" /> Retry build</button>
        ) : null}
      </BrandCard>
    </StepFrame>
  );
}

function ReadyStep({ title, computer, onReturn }: { title: string; computer?: MatrixComputer; onReturn: () => void }) {
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12">
        <CheckCircle2Icon className="mx-auto size-10 text-success" aria-hidden="true" />
        <h1 className="mt-5 text-3xl font-semibold">{title} is ready</h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-forest/65">Your new computer has independent files, apps, and data.</p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          {computer ? <a href={computer.gatewayPath} className="primary-action"><ExternalLinkIcon className="size-4" aria-hidden="true" /> Open computer</a> : null}
          <button type="button" onClick={onReturn} className="secondary-action">All computers</button>
        </div>
      </BrandCard>
    </StepFrame>
  );
}

function ErrorStep({ message, managed, onRetry, onBack }: { message: string; managed: boolean; onRetry: () => void; onBack: () => void }) {
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12">
        {managed ? <ShieldCheckIcon className="mx-auto size-9 text-forest" aria-hidden="true" /> : <CircleAlertIcon className="mx-auto size-9 text-ember" aria-hidden="true" />}
        <h1 className="mt-5 text-2xl font-semibold">{managed ? "Managed computer capacity" : "Computer setup paused"}</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-forest/65" role="alert">{message}</p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          {!managed ? <button type="button" onClick={onRetry} className="primary-action">Try again</button> : null}
          <button type="button" onClick={onBack} className="secondary-action">Back to computers</button>
        </div>
      </BrandCard>
    </StepFrame>
  );
}
