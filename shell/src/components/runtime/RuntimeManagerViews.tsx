"use client";

import { BrandCard, Eyebrow } from "@matrix-os/brand";
import type { MatrixComputer } from "@matrix-os/contracts";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { platformShellAssetPath } from "@/lib/platform-shell-assets";
import type { JourneyState, OverviewState } from "./RuntimeManager";
import { runtimeSlotTitle } from "./runtime-name";

const MATRIX_SHIMMER =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 24%, #C4A265 50%, #2F392C 76%, #2F392C 100%)";

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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center py-7 sm:py-12">
      <header className="text-center">
        <Link
          href="/"
          aria-label="Matrix OS home"
          className="mx-auto mb-7 inline-flex w-fit flex-row items-center justify-center gap-3.5 text-forest no-underline sm:mb-8"
        >
          <Image
            src={platformShellAssetPath("/matrix-logo.svg")}
            alt="Matrix OS logo"
            width={27}
            height={36}
            priority
            unoptimized
            className="h-9 w-[27px] shrink-0"
          />
          <span
            className="inline-flex h-9 items-center text-[15px] font-semibold leading-none tracking-[0.16em] sm:text-base"
            style={{ color: "#32352E", fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
          >
            Matrix OS
          </span>
        </Link>
        <h1
          className="mx-auto block w-fit bg-clip-text pb-[0.12em] text-[clamp(2.35rem,5vw,4.25rem)] font-medium leading-[1.08] tracking-[-0.055em] text-transparent [animation:onboard-shimmer_8s_ease-in-out_infinite,onboard-glow_8s_ease-in-out_infinite] motion-reduce:animate-none"
          style={{
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            backgroundImage: MATRIX_SHIMMER,
            backgroundSize: "300% 100%",
          }}
        >
          Choose your computer
        </h1>
      </header>

      {overview.status === "loading" ? (
        <div className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-8 sm:gap-x-6" aria-label="Loading computers" aria-busy="true">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="flex w-[calc(50%_-_0.5rem)] max-w-44 animate-pulse flex-col items-center sm:w-44">
              <span className="size-24 rounded-full bg-forest/[0.07]" />
              <span className="mt-4 h-4 w-24 rounded bg-forest/[0.07]" />
            </div>
          ))}
        </div>
      ) : null}
      {overview.status === "error" ? (
        <BrandCard className="mx-auto mt-10 max-w-md p-6 text-center">
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
          <div className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-9 sm:gap-x-6" aria-label="Matrix OS computers">
            {overview.inventory.items.map((computer) => (
              <ComputerProfile key={computer.runtimeSlot} computer={computer} current={computer.runtimeSlot === overview.inventory.selectedSlot} />
            ))}
            <button
              type="button"
              onClick={onAdd}
              aria-label="Get another computer"
              className="group flex w-[calc(50%_-_0.5rem)] max-w-44 min-w-0 flex-col items-center rounded-3xl px-2 py-2 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-4 sm:w-44"
            >
              <span className="grid size-24 place-items-center rounded-full border border-dashed border-forest/20 bg-white/35 text-forest/45 transition duration-200 group-hover:scale-[1.03] group-hover:border-ember/40 group-hover:bg-white/70 group-hover:text-ember group-focus-visible:scale-[1.03]">
                <PlusIcon className="size-7" aria-hidden="true" />
              </span>
              <strong className="mt-4 block truncate text-[15px] font-medium tracking-[-0.015em] text-deep">New computer</strong>
              <span className="mt-1 text-xs text-forest/45">Buy another</span>
            </button>
          </div>
        ) : (
          <BrandCard className="mx-auto mt-10 flex max-w-md flex-col items-center p-8 text-center">
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

const COMPUTER_EMOJIS = ["🦊", "🐼", "🐯", "🐸", "🐙", "🦉", "🐳"] as const;
const COMPUTER_TONES = [
  "bg-[#F3E5D1]",
  "bg-[#E7E9DD]",
  "bg-[#E9E2D6]",
  "bg-[#DDE9DF]",
  "bg-[#E8E0E9]",
  "bg-[#E2E6EA]",
  "bg-[#E2E8E5]",
] as const;

function computerIdentity(computer: MatrixComputer): { emoji: string; tone: string } {
  if (computer.kind === "preview") return { emoji: "🧪", tone: "bg-[#E8E8E1]" };
  if (computer.runtimeSlot === "primary") return { emoji: "🐇", tone: "bg-[#F4E4CF]" };
  const index = [...computer.runtimeSlot].reduce((total, character) => total + character.codePointAt(0)!, 0) % COMPUTER_EMOJIS.length;
  return { emoji: COMPUTER_EMOJIS[index]!, tone: COMPUTER_TONES[index]! };
}

function ComputerProfile({ computer, current }: { computer: MatrixComputer; current: boolean }) {
  const title = computer.runtimeSlot === "primary" ? "Main Computer" : runtimeSlotTitle(computer.runtimeSlot);
  const available = computer.availability === "available";
  const status = available ? "Ready" : computer.availability === "starting" ? "Building" : "Unavailable";
  const identity = computerIdentity(computer);

  return (
    <a
      href={available ? computer.gatewayPath : undefined}
      aria-label={available ? `Switch to ${title}` : `${title} is ${status.toLowerCase()}`}
      aria-disabled={!available || undefined}
      className={`group flex w-[calc(50%_-_0.5rem)] max-w-44 min-w-0 flex-col items-center rounded-3xl px-2 py-2 text-center no-underline outline-none transition focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-4 sm:w-44 ${available ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className="relative">
        <span className={`grid size-24 place-items-center rounded-full border text-[2.7rem] shadow-[0_16px_40px_rgba(50,53,46,0.09)] transition duration-200 ${identity.tone} ${current ? "border-ember ring-4 ring-ember/10" : "border-white/65 group-hover:scale-[1.03] group-hover:border-white"}`}>
          <span aria-hidden="true">{identity.emoji}</span>
        </span>
        <span className={`absolute bottom-1 right-1 size-4 rounded-full border-[3px] border-[#F2F1E8] ${available ? "bg-[#6F8E58]" : computer.availability === "starting" ? "bg-ember" : "bg-forest/25"}`} aria-label={status} />
      </span>
      <span className="mt-4 block max-w-full">
        <strong className="block text-[15px] font-medium leading-5 tracking-[-0.015em] text-deep">{title}</strong>
        {current ? <span className="mt-1 inline-flex rounded-full bg-ember/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ember">Current</span> : null}
      </span>
      <span className="mt-1 truncate text-xs text-forest/50">{computer.label} · {status}</span>
      <span className="mt-1 truncate text-[11px] text-forest/40">{computer.versionLabel ?? "Version pending"}</span>
      <code className="mt-2 block max-w-full truncate rounded-full bg-white/35 px-2 py-1 text-[9px] text-forest/35" title={computer.gatewayPath}>{computer.gatewayPath}</code>
    </a>
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
        <Eyebrow>New computer · 1 of 3</Eyebrow>
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

export function BillingWait({ title }: { title: string }) {
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12" aria-live="polite">
        <Loader2Icon className="mx-auto size-9 animate-spin text-ember" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold">Activating your computer subscription</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-forest/65">
          We’re waiting for Stripe’s signed update before building {title}. The redirect alone never starts provisioning.
        </p>
      </BrandCard>
    </StepFrame>
  );
}

export function ProvisioningStep({
  title,
  journey,
  onRetry,
  onBack,
}: {
  title: string;
  journey: JourneyState | null;
  onRetry: () => void;
  onBack: () => void;
}) {
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
        {failed ? (
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            {journey.failure?.retryable ? (
              <button type="button" onClick={onRetry} className="primary-action"><RefreshCwIcon className="size-4" aria-hidden="true" /> Retry build</button>
            ) : null}
            <button type="button" onClick={onBack} className="secondary-action">Back to computers</button>
          </div>
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

export function ErrorStep({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  return (
    <StepFrame>
      <BrandCard className="p-8 text-center sm:p-12">
        <CircleAlertIcon className="mx-auto size-9 text-ember" aria-hidden="true" />
        <h1 className="mt-5 text-2xl font-semibold">Computer setup paused</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-forest/65" role="alert">{message}</p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <button type="button" onClick={onRetry} className="primary-action">Try again</button>
          <button type="button" onClick={onBack} className="secondary-action">Back to computers</button>
        </div>
      </BrandCard>
    </StepFrame>
  );
}
