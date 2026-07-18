"use client";

import { BrandCard, Eyebrow, palette as brand, StatusPill } from "@matrix-os/brand";
import type { MatrixComputer } from "@matrix-os/contracts";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  CloudIcon,
  ExternalLinkIcon,
  HardDriveIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { DeveloperToolId } from "@/components/onboarding/developer-tools";
import { DeveloperToolsSelector } from "@/components/onboarding/DefaultInstallsStep";
import type { JourneyState, OverviewState } from "./RuntimeManager";
import { runtimeSlotTitle } from "./runtime-name";

function journeyStageLabel(stage: NonNullable<JourneyState["progress"]>["stage"]): string {
  if (stage === "creating_server") return "Creating server";
  if (stage === "booting") return "Booting";
  if (stage === "registering") return "Registering";
  if (stage === "finalizing") return "Finalizing";
  return "Building";
}

export function RuntimeLoading() {
  return (
    <main className="grid h-dvh place-items-center bg-page-bg text-forest" aria-busy="true">
      <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading your computers</span>
    </main>
  );
}

export function ComputerInventory({
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

function StepFrame({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
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

export function NameStep({
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

export function InstallsStep({
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

export function BillingWait({ title }: { title: string }) {
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

export function ProvisioningStep({ title, journey, onRetry }: { title: string; journey: JourneyState | null; onRetry: () => void }) {
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

export function ReadyStep({ title, computer, onReturn }: { title: string; computer?: MatrixComputer; onReturn: () => void }) {
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

export function ErrorStep({ message, managed, onRetry, onBack }: { message: string; managed: boolean; onRetry: () => void; onBack: () => void }) {
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
