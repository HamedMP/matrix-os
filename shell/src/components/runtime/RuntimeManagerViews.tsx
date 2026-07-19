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
  const customerCount = overview.status === "ready"
    ? overview.inventory.items.filter((computer) => computer.kind === "customer").length
    : 0;
  const readyCount = overview.status === "ready"
    ? overview.inventory.items.filter((computer) => computer.availability === "available").length
    : 0;

  return (
    <div>
      <section className="relative overflow-hidden rounded-[28px] border border-white/70 bg-white/55 px-5 py-7 shadow-[0_32px_100px_rgba(50,53,46,0.12)] backdrop-blur-xl sm:px-9 sm:py-10 lg:px-12 lg:py-12">
        <div className="absolute -right-24 -top-32 size-80 rounded-full bg-ember/10 blur-3xl sm:-right-10 sm:size-[28rem]" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-24 size-80 rounded-full bg-cream/80 blur-3xl" aria-hidden="true" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-28 right-4 hidden h-[25rem] w-[19rem] bg-forest/[0.045] lg:block"
          style={{
            WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
            mask: "url('/matrix-logo.svg') no-repeat center / contain",
          }}
        />

        <div className="relative max-w-4xl">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl border border-forest/10 bg-white/75 shadow-[0_12px_32px_rgba(50,53,46,0.08)]">
              <span
                aria-hidden="true"
                className="h-5 w-4 bg-ember"
                style={{
                  WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
                  mask: "url('/matrix-logo.svg') no-repeat center / contain",
                }}
              />
            </span>
            <Eyebrow>Switch computer</Eyebrow>
          </div>
          <h1 className="mt-5 max-w-4xl bg-[linear-gradient(92deg,#32352E_0%,#434E3F_35%,#D06F25_52%,#434E3F_72%,#32352E_100%)] bg-[length:220%_100%] bg-clip-text text-[clamp(2.7rem,7.5vw,5.6rem)] font-medium uppercase leading-[0.91] tracking-[-0.055em] text-transparent">
            Choose your Matrix OS computer
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-6 text-forest/65 sm:text-base sm:leading-7">
            Every computer is its own private workspace. Open the one you need, check a build, or create another with independent files and data.
          </p>
          <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center">
            <button type="button" onClick={onAdd} className="primary-action w-full sm:w-auto">
              <PlusIcon className="size-4" aria-hidden="true" /> Get another computer
            </button>
            {overview.status === "ready" ? (
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-forest/55" aria-label="Computer summary">
                <span className="rounded-full border border-forest/10 bg-white/65 px-3 py-2">{customerCount} {customerCount === 1 ? "computer" : "computers"}</span>
                <span className="rounded-full border border-forest/10 bg-white/65 px-3 py-2">{readyCount} ready</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mt-10 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Available workspaces</Eyebrow>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-deep sm:text-3xl">Your computers</h2>
        </div>
        <span className="hidden text-xs font-medium text-forest/45 sm:block">Select a computer to continue</span>
      </div>

      {overview.status === "loading" ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2" aria-label="Loading computers" aria-busy="true">
          {[0, 1].map((item) => <div key={item} className="h-64 animate-pulse rounded-[22px] border border-white/70 bg-white/55" />)}
        </div>
      ) : null}
      {overview.status === "error" ? (
        <BrandCard className="mt-5 p-6">
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
          <div className="mt-5 grid gap-4 md:grid-cols-2" aria-label="Matrix OS computers">
            {overview.inventory.items.map((computer) => (
              <ComputerCard key={computer.runtimeSlot} computer={computer} current={computer.runtimeSlot === overview.inventory.selectedSlot} />
            ))}
          </div>
        ) : (
          <BrandCard className="mt-5 flex flex-col items-center p-8 text-center">
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
    <BrandCard
      className="group relative flex min-h-64 flex-col overflow-hidden p-5 transition duration-300 hover:-translate-y-1 sm:p-6"
      style={{
        borderRadius: 22,
        background: current
          ? "linear-gradient(145deg, rgba(255,255,255,0.96), rgba(250,246,235,0.94))"
          : "rgba(252,252,248,0.82)",
        ...(current
          ? { borderColor: brand.ember, boxShadow: "0 28px 80px rgba(50,53,46,0.14)" }
          : { boxShadow: "0 18px 55px rgba(50,53,46,0.08)" }),
      }}
    >
      <span className={`absolute inset-x-0 top-0 h-1 ${current ? "bg-ember" : "bg-forest/10"}`} aria-hidden="true" />
      <div className="flex items-start justify-between gap-4">
        <span className={`grid size-12 place-items-center rounded-2xl border ${current ? "border-ember/20 bg-ember/10 text-ember" : "border-forest/10 bg-forest/[0.06] text-forest"}`}>
          {computer.kind === "preview" ? (
            <CloudIcon className="size-5" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className="h-6 w-[19px] bg-current"
              style={{
                WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
                mask: "url('/matrix-logo.svg') no-repeat center / contain",
              }}
            />
          )}
        </span>
        <StatusPill tone={tone}>{computer.availability === "available" ? "Ready" : computer.availability === "starting" ? "Building" : "Unavailable"}</StatusPill>
      </div>
      <div className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
          {current ? <span className="rounded-full bg-ember/10 px-2 py-1 text-[11px] font-semibold text-ember">Current computer</span> : null}
        </div>
        <p className="mt-1 text-sm text-forest/55">{computer.label} · {computer.runtimeSlot}</p>
        <code className="mt-3 block truncate rounded-lg bg-forest/[0.045] px-2.5 py-2 text-[11px] text-forest/50" title={computer.gatewayPath}>
          {computer.gatewayPath}
        </code>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-6">
        <span className="text-xs font-medium text-forest/50"><span className="text-forest/35">Version</span> · {computer.versionLabel ?? "Pending"}</span>
        {available ? (
          <a className={current ? "primary-action" : "secondary-action"} href={computer.gatewayPath} aria-label={`Open ${title}`}>
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
